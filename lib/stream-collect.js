'use strict';

const Transform = require('stream').Transform;

class StreamCollect extends Transform {
    constructor(options) {
        super();
        this.options = options || {};
        this.chunks = [];
        this.chunklen = 0;
    }
    _transform(chunk, encoding, done) {
        this.chunks.push(chunk);
        this.chunklen += chunk.length;
        this.push(chunk);
        done();
    }
}

module.exports = StreamCollect;
