/* eslint-env es6 */
/* globals DENY: false, OK: false, DENYSOFT: false */

'use strict';

// disable config loading by Wild Duck
process.env.DISABLE_WILD_CONFIG = 'true';

const ObjectID = require('mongodb').ObjectID;
const db = require('./lib/db');
const DSN = require('./dsn');
const punycode = require('punycode');
const base32 = require('hi-base32');
const SRS = require('srs.js');
const crypto = require('crypto');
const counters = require('wildduck/lib/counters');
const tools = require('wildduck/lib/tools');
const StreamCollect = require('./lib/stream-collect');
const Maildropper = require('wildduck/lib/maildropper');
const FilterHandler = require('wildduck/lib/filter-handler');
const consts = require('wildduck/lib/consts');

DSN.rcpt_too_fast = () =>
    DSN.create(
        450,
        '450-4.2.1 The user you are trying to contact is receiving mail at a rate that\nprevents additional messages from being delivered. Please resend your\nmessage at a later time. If the user is able to receive mail at that\ntime, your message will be delivered.',
        2,
        1
    );

exports.register = function() {
    let plugin = this;
    plugin.logdebug('Initializing rcpt_to Wild Duck plugin.');
    plugin.load_wildduck_ini();

    plugin.register_hook('init_master', 'init_wildduck_shared');
    plugin.register_hook('init_child', 'init_wildduck_shared');
};

exports.load_wildduck_ini = function() {
    let plugin = this;

    plugin.cfg = plugin.config.get(
        'wildduck.yaml',
        {
            booleans: ['accounts.createMissing', 'attachments.decodeBase64', 'sender.enabled']
        },
        () => {
            plugin.load_wildduck_ini();
        }
    );
};

exports.open_database = function(server, next) {
    let plugin = this;

    plugin.srsRewriter = new SRS({
        secret: plugin.cfg.srs.secret
    });

    db.connect(server.notes.redis, plugin.cfg, (err, db) => {
        if (err) {
            return next(err);
        }
        plugin.db = db;
        plugin.ttlcounter = counters(db.redis).ttlcounter;

        plugin.maildrop = new Maildropper({
            db,
            enabled: plugin.cfg.sender.enabled,
            zone: plugin.cfg.sender.zone,
            collection: plugin.cfg.sender.collection,
            gfs: plugin.cfg.sender.gfs
        });

        let spamChecks = plugin.cfg.spamHeaders && tools.prepareSpamChecks(plugin.cfg.spamHeaders);

        plugin.filterHandler = new FilterHandler({
            db,
            sender: plugin.cfg.sender,
            messageHandler: plugin.db.messageHandler,
            spamChecks,
            spamHeaderKeys: spamChecks && spamChecks.map(check => check.key)
        });

        plugin.loginfo('Database connection opened');
        next();
    });
};

exports.normalize_address = function(address) {
    if (/^SRS\d+=/i.test(address.user)) {
        // Try to fix case-mangled addresses where the intermediate MTA converts user part to lower case
        // and thus breaks hash verification
        let localAddress = address.user
            // ensure that address starts with uppercase SRS
            .replace(/^SRS\d+=/i, val => val.toUpperCase())
            // ensure that the first entity that looks like SRS timestamp is uppercase
            .replace(/([-=+][0-9a-f]{4})(=[A-Z2-7]{2}=)/i, (str, sig, ts) => sig + ts.toUpperCase());

        return localAddress + '@' + punycode.toUnicode(address.host.toLowerCase().trim());
    }

    return tools.normalizeAddress(address.address());
};

exports.init_wildduck_shared = function(next, server) {
    let plugin = this;

    plugin.open_database(server, next);
};

exports.hook_mail = function(next, connection, params) {
    let from = params[0];
    connection.transaction.notes.sender = from.address();

    connection.transaction.notes.id = new ObjectID();
    connection.transaction.notes.targets = {
        users: new Map(),
        forward: new Map(),
        recipients: new Set()
    };

    connection.transaction.notes.transmissionType = []
        .concat(connection.greeting === 'EHLO' ? 'E' : [])
        .concat('SMTP')
        .concat(connection.tls_cipher ? 'S' : [])
        .join('');

    return next();
};

exports.hook_rcpt = function(next, connection, params) {
    let plugin = this;

    let rcpt = params[0];
    if (/\*/.test(rcpt.user)) {
        // Using * is not allowed in addresses
        return next(DENY, DSN.no_such_user());
    }

    let address = plugin.normalize_address(rcpt);

    connection.transaction.notes.targets.recipients.add(address);

    plugin.logdebug('Checking validity of ' + address);

    if (/^SRS\d+=/.test(address)) {
        let reversed = false;
        try {
            reversed = plugin.srsRewriter.reverse(address.substr(0, address.indexOf('@')));
            let toDomain = punycode.toASCII(
                (reversed[1] || '')
                    .toString()
                    .toLowerCase()
                    .trim()
            );

            if (!toDomain) {
                plugin.logerror('SRS check failed for ' + address + '. Missing domain');
                return next(DENY, DSN.no_such_user());
            }

            reversed = reversed.join('@');
        } catch (E) {
            plugin.logerror('SRS check failed for ' + address + '. ' + E.message);
            return next(DENY, DSN.no_such_user());
        }

        if (reversed) {
            // accept SRS rewritten address
            return plugin.rateLimit(connection, 'rcpt', reversed, (err, success) => {
                if (err) {
                    return next(err);
                }

                if (!success) {
                    return next(DENYSOFT, DSN.rcpt_too_fast());
                }

                connection.transaction.notes.targets.forward.set(reversed, { type: 'mail', value: reversed });
                return next(OK);
            });
        }
    }

    let createAccount = () => {
        let domain = address.substr(address.lastIndexOf('@') + 1);

        if (!plugin.cfg.accounts.hosts.includes('*') && !plugin.cfg.accounts.hosts.includes(domain)) {
            plugin.logerror('Failed to create account for "' + address + '". Domain "' + domain + '" not allowed');
            return next(DENY, DSN.no_such_user());
        }

        let username = base32
            .encode(
                crypto
                    .createHash('md5')
                    .update(address.substr(0, address.indexOf('@')).replace(/\./g, '') + address.substr(address.indexOf('@')))
                    .digest()
            )
            .toLowerCase()
            .replace(/[=]+$/g, '');

        let userData = {
            username,
            address,
            recipients: Number(plugin.cfg.accounts.maxRecipients) || 0,
            forwards: Number(plugin.cfg.accounts.maxForwards) || 0,
            quota: Number(plugin.cfg.accounts.maxStorage || 0) * 1024 * 1024,
            retention: Number(plugin.cfg.accounts.retention) || 0,
            ip: connection.remote.ip
        };

        plugin.db.userHandler.create(userData, (err, id) => {
            if (err) {
                plugin.logerror('Failed to create account for "' + address + '". ' + err.message);
                return next(DENY, DSN.no_such_user());
            }
            plugin.loginfo('Created account for "' + address + '" with id "' + id + '"');

            return plugin.rateLimit(connection, 'rcpt', address, (err, success) => {
                if (err) {
                    return next(err);
                }

                if (!success) {
                    return next(DENYSOFT, DSN.rcpt_too_fast());
                }

                userData._id = id;
                connection.transaction.notes.targets.users.set(id.toString(), { user: userData, recipient: rcpt.address() });
                return next(OK);
            });
        });
    };

    let handleForwardingAddress = addressData => {
        plugin.ttlcounter(
            'wdf:' + addressData._id.toString(),
            addressData.targets.length,
            addressData.forwards || consts.MAX_FORWARDS,
            false,
            (err, result) => {
                if (err) {
                    // failed checks
                    return next(err);
                } else if (!result.success) {
                    connection.logdebug(
                        plugin,
                        'Rate limit target=' +
                            addressData.address +
                            ' key=' +
                            addressData._id +
                            ' limit=' +
                            addressData.forwards +
                            ' value=' +
                            result.value +
                            ' ttl=' +
                            result.ttl
                    );
                    return next(DENYSOFT, DSN.rcpt_too_fast());
                }

                let pos = 0;
                let processTarget = () => {
                    if (pos >= addressData.targets.length) {
                        return next(OK);
                    }

                    let target = addressData.targets[pos++];

                    if (target.type === 'relay') {
                        // relay is not rate limited
                        target.recipient = rcpt.address();
                        connection.transaction.notes.targets.forward.set(target.value, target);
                        return setImmediate(processTarget);
                    }

                    if (target.type === 'http' || (target.type === 'mail' && !target.user)) {
                        if (target.type !== 'mail') {
                            target.recipient = rcpt.address();
                        }

                        connection.transaction.notes.targets.forward.set(target.value, target);
                        return setImmediate(processTarget);
                    }

                    if (target.type !== 'mail') {
                        // no idea what to do here, some new feature probably
                        return setImmediate(processTarget);
                    }

                    if (connection.transaction.notes.targets.users.has(target.user.toString())) {
                        return setImmediate(processTarget);
                    }

                    // we have a target user, so we need to resolve user data
                    plugin.db.users.collection('users').findOne(
                        { _id: target.user },
                        {
                            name: true,
                            forwards: true,
                            forward: true,
                            targetUrl: true,
                            autoreply: true,
                            encryptMessages: true,
                            encryptForwarded: true,
                            pubKey: true
                        },
                        (err, userData) => {
                            if (err) {
                                err.code = 'InternalDatabaseError';
                                return next(err);
                            }

                            if (!userData || userData.disabled) {
                                return setImmediate(processTarget);
                            }

                            // max quota for the user
                            let quota = userData.quota || Number(plugin.cfg.accounts.maxStorage || 0) * 1024 * 1024;

                            if (userData.storageUsed && quota <= userData.storageUsed) {
                                // can not deliver mail to this user, over quota
                                return setImmediate(processTarget);
                            }

                            connection.transaction.notes.targets.users.set(userData._id.toString(), { user: userData, recipient: rcpt.address() });
                            setImmediate(processTarget);
                        }
                    );
                };

                setImmediate(processTarget);
            }
        );
    };

    plugin.db.userHandler.resolveAddress(address, { wildcard: true }, (err, addressData) => {
        if (err) {
            return next(err);
        }

        if (addressData && addressData.targets) {
            return handleForwardingAddress();
        }

        if (!addressData || !addressData.user) {
            if (plugin.cfg.accounts && plugin.cfg.accounts.createMissing) {
                return createAccount();
            }
            return next(DENY, DSN.no_such_user());
        }

        plugin.db.userHandler.get(
            addressData.user,
            {
                name: true,
                forwards: true,
                forward: true,
                targetUrl: true,
                autoreply: true,
                encryptMessages: true,
                encryptForwarded: true,
                pubKey: true
            },
            (err, userData) => {
                if (err) {
                    return next(err);
                }

                if (!userData) {
                    if (plugin.cfg.accounts && plugin.cfg.accounts.createMissing) {
                        return createAccount();
                    }
                    return next(DENY, DSN.no_such_user());
                }

                if (userData.disabled) {
                    // user is disabled for whatever reason
                    return next(DENY, DSN.mbox_disabled());
                }

                // max quota for the user
                let quota = userData.quota || Number(plugin.cfg.accounts.maxStorage || 0) * 1024 * 1024;

                if (userData.storageUsed && quota <= userData.storageUsed) {
                    // can not deliver mail to this user, over quota
                    return next(DENY, DSN.mbox_full());
                }

                return plugin.rateLimit(connection, 'rcpt', userData._id.toString(), (err, success) => {
                    if (err) {
                        return next(err);
                    }

                    if (!success) {
                        return next(DENYSOFT, DSN.rcpt_too_fast());
                    }

                    connection.transaction.notes.targets.users.set(userData._id.toString(), { user: userData, recipient: rcpt.address() });
                    return next(OK);
                });
            }
        );
    });
};

exports.hook_queue = function(next, connection) {
    let plugin = this;

    let collector = new StreamCollect();

    let collectData = done => {
        // buffer message chunks by draining the stream
        collector.on('data', () => false); //just drain
        connection.transaction.message_stream.once('error', err => collector.emit('error', err));
        collector.once('end', done);

        collector.once('error', err => {
            plugin.logerror('Failed to retrieve message. error=' + err.message);
            return next(DENYSOFT, 'Failed to Queue message');
        });

        connection.transaction.message_stream.pipe(collector);
    };

    let forwardMessage = done => {
        if (!connection.transaction.notes.targets.forward.size) {
            // the message does not need forwarding at this point
            return collectData(done);
        }

        let targets = connection.transaction.notes.targets.forward.size
            ? Array.from(connection.transaction.notes.targets.forward).map(row => ({
                type: row[1].type,
                value: row[1].value,
                recipient: row[1].recipient
            }))
            : false;

        let mail = {
            parentId: connection.transaction.notes.id,
            reason: 'forward',

            from: connection.transaction.notes.sender,
            to: [],

            targets,

            interface: 'forwarder'
        };

        let message = plugin.maildrop.push(mail, (err, ...args) => {
            if (err || !args[0]) {
                if (err) {
                    err.code = err.code || 'ERRCOMPOSE';
                    return next(DENYSOFT, 'Failed to Queue message');
                }
                return done(err, ...args);
            }

            plugin.db.database.collection('messagelog').insertOne(
                {
                    id: args[0].id,
                    messageId: args[0].messageId,
                    queueId: connection.transaction.uuid,
                    action: 'FORWARD',
                    from: connection.transaction.notes.sender,
                    to: Array.from(connection.transaction.notes.targets.recipients),
                    targets,
                    created: new Date()
                },
                () => done(err, args && args[0] && args[0].id)
            );
        });

        if (message) {
            connection.transaction.message_stream.once('error', err => message.emit('error', err));
            message.once('error', err => {
                plugin.logerror('Failed to retrieve message. error=' + err.message);
                return next(DENYSOFT, 'Failed to Queue message');
            });

            // pipe the message to the collector object to gather message chunks for further processing
            connection.transaction.message_stream.pipe(collector).pipe(message);
        }
    };

    // try to forward the message. If forwarding is not needed then continues immediatelly
    forwardMessage(() => {
        let prepared = false;

        let users = Array.from(connection.transaction.notes.targets.users).map(e => e[1]);
        let stored = 0;

        let storeNext = () => {
            if (stored >= users.length) {
                return next(OK, 'Message processed');
            }

            let rcptData = users[stored++];
            let recipient = rcptData.recipient;
            let userData = rcptData.user;

            plugin.filterHandler.process(
                {
                    mimeTree: prepared && prepared.mimeTree,
                    maildata: prepared && prepared.maildata,
                    user: userData,
                    sender: connection.transaction.notes.sender,
                    recipient,
                    chunks: collector.chunks,
                    chunklen: collector.chunklen,
                    meta: {
                        transactionId: connection.transaction.uuid,
                        source: 'MX',
                        from: connection.transaction.notes.sender,
                        to: [recipient],
                        origin: connection.remote_ip,
                        transhost: connection.hello.host,
                        transtype: connection.transaction.notes.transmissionType,
                        time: new Date()
                    }
                },
                (err, response, preparedResponse) => {
                    if (err) {
                        // we can fail the message even if some recipients were already processed
                        // as redelivery would not be a problem - duplicate deliveries are ignored (filters are rerun though).
                        return next(DENYSOFT, 'Failed to Queue message');
                    }

                    if (response && response.error) {
                        return next(response.error.code === 'DroppedByPolicy' ? DENY : DENYSOFT, response.error.message);
                    }

                    if (!prepared && preparedResponse) {
                        // reuse parsed message structure
                        prepared = preparedResponse;
                    }

                    setImmediate(storeNext);
                }
            );
        };
        storeNext();
    });
};

exports.rateLimit = function(connection, key, value, next) {
    let plugin = this;

    let limit = plugin.cfg.limits[key];
    if (!limit) {
        return next(null, true);
    }
    let windowSize = plugin.cfg.limits[key + 'WindowSize'] || plugin.cfg.limits.windowSize || 1 * 3600 * 1000;

    plugin.ttlcounter('rl:' + key + ':' + value, 1, limit, windowSize, (err, result) => {
        if (err) {
            return next(err);
        }

        connection.logdebug(plugin, 'Rate limit target=' + value + ' key=' + key + ' limit=' + limit + ' value=' + result.value + ' ttl=' + result.ttl);

        return next(null, result.success);
    });
};
