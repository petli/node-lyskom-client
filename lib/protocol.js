/* LysKOM protocol A definitions
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var debug = require('debug')('lyskom-client:protocol'); // jshint ignore:line
var iconv = require('iconv-lite');

var errors = require('./errors');


//
// Compound protocol types
//

/** A field in a Structure. */
var Field = function(name, type) {
    this.name = name;
    this.type = type;
};

/** A Structure of a sequence of fields.
 */
var Structure = function() {
    this.fields = Array.prototype.slice.call(arguments);
};

Structure.prototype.getParser = function() {
    var i = 0;
    var obj = {};
    var fields = this.fields;
    var currentParser = null;

    return function(msg) {
        while (i < fields.length) {
            if (!currentParser) {
                currentParser = fields[i].type.getParser();
            }

            var v = currentParser(msg);
            if (v === null) {
                // Not yet a full parse
                return null;
            }

            obj[fields[i].name] = v;
            currentParser = null;
            i++;
        }

        return obj;
    };
};


Structure.prototype.format = function(formatter, obj) {
    if (typeof obj !== 'object') {
        throw new TypeError('Structure require an object: ' + obj);
    }

    for (var i = 0; i < this.fields.length; i++) {
        var f = this.fields[i];
        var v = obj[f.name];

        if (v === undefined && !obj.hasOwnProperty(f.name)) {
            throw new TypeError('missing structure field: ' + f.name);
        }

        try {
            f.type.format(formatter, v);
        }
        catch (err) {
            throw new TypeError('invalid value for ' + f.name + ': ' + err.message);
        }
    }
};


/** An array of values all of a single type
 */
var KOMArray = function(type) {
    this.type = type;
};

KOMArray.prototype.format = function(formatter, a) {
    if (!Array.isArray(a)) {
        throw new TypeError('must be an array: ' + a);
    }

    formatter.addField(a.length.toString());
    formatter.addField('{');

    for (var i = 0; i < a.length; i++) {
        this.type.format(formatter, a[i]);
    }

    formatter.addField('}');
};


//
// Scalars have static methods, so no need for classes
//

// Dummy type for empty sequences
var Empty = {
    getParser: function() {
        return Empty.parser;
    },

    parser: function() {
        return {};
    },

    format: function() { }
};


var Int = {
    getParser: function() {
        return Int.parser;
    },

    parser: function(msg) {
        var t = msg.nextToken();
        if (t) {
            if (t.type !== 'int') {
                throw new errors.ProtocolError('expected int, got ' + t.type + ': ' + t.value);
            }

            return t.value;
        }
        else {
            return null;
        }
    },

    format: function(formatter, v) {
        if (typeof v !== 'number') {
            throw new TypeError('invalid value for int: ' + v);
        }

        formatter.addField(Math.floor(v).toString());
    },
};


var Bool = {
    getParser: function() {
        return Bool.parser;
    },

    parser: function(msg) {
        var t = msg.nextToken();
        if (t) {
            if (t.type !== 'int') {
                throw new errors.ProtocolError('expected bool, got ' + t.type + ': ' + t.value);
            }

            return t.value !== 0;
        }
        else {
            return null;
        }
    },

    format: function(formatter, v) {
        formatter.addField(v ? '1' : '0');
    },
};


var HollerithString = {
    getParser: function() {
        return HollerithString.parser;
    },

    parser: function(msg) {
        var t = msg.nextToken();
        if (t) {
            if (t.type !== 'string') {
                throw new errors.ProtocolError('expected string, got ' + t.type + ': ' + t.value);
            }

            return t.value;
        }
        else {
            return null;
        }
    },

    format: function(formatter, v) {
        if (typeof v === 'string') {
            // change to latin1 buffer
            v = iconv.encode(v, 'latin1');
        }

        if (!(v instanceof Buffer)) {
            throw new TypeError('invalid string value: ' + v);
        }

        // Add length and hollerith tag
        formatter.addField('' + v.length + 'H');
        formatter.write(v);
    },
};



//
// Utitlity functions for defining typed fields
//

var int = function(name) { return new Field(name, Int); };
var int32 = int,
    //int16 = int,
    //int8 = int,
    confNo = int,
    persNo = int;

var bool = function(name) { return new Field(name, Bool); };

var string = function(name) { return new Field(name, HollerithString); };

var array = function(name, type) { return new Field(name, new KOMArray(type)); };

//
// Finally, the protocol definitions
//

var rpcDefs = {
    acceptAsync: {
        num: 80,
        req: new Structure(array('requestList', Int)),
        res: Empty,
    },

    login: {
        num: 62,
        req: new Structure(persNo('person'),
                           string('passwd'),
                           bool('invisible')),
        res: Empty,
    },

    logout: {
        num: 1,
        req: Empty,
        res: Empty,
    },

    sendMessage: {
        num: 53,
        req: new Structure(confNo('recipient'),
                           string('message')),
        res: Empty,
    },
};


var requestError = new Structure(int32('errorCode'), int32('errorStatus'));


var asyncDefs = {
    sendMessage: {
        num: 12,
        msg: new Structure(confNo('recipient'),
                           persNo('sender'),
                           string('message'))
    },
};

var asyncLookup = [];

// Export async name-number map for callers of rpc.acceptAsync
exports.async = {};

for (var k in asyncDefs) {
    if (asyncDefs.hasOwnProperty(k)) {
        var a = asyncDefs[k];
        exports.async[k] = a.num;
        asyncLookup[a.num] = a;
    }
}


//
// Protocol parsing and generating support classes
//

var RequestFormatter = function(rpc, refNo, params) {
    // Most messages should fit into this
    this.buffer = new Buffer(1000);
    this.pos = 0;

    // Requests start with the reference number and the request number
    this.write(refNo.toString());
    this.addField(rpc.num.toString());

    rpc.req.format(this, params);

    return this.write('\n');
};

RequestFormatter.prototype.ensureSpace = function(bytes) {
    var diff = this.pos + bytes - this.buffer.length;
    if (diff > 0) {
        this.buffer = Buffer.concat([this.buffer, new Buffer(diff + 1000)]);
    }
};

RequestFormatter.prototype.write = function(stringOrBuffer) {
    if (typeof stringOrBuffer === 'string') {
        this.ensureSpace(stringOrBuffer.length);

        // the string must be ascii-codable
        this.pos += this.buffer.write(stringOrBuffer, this.pos, undefined, 'ascii');
    }
    else {
        this.ensureSpace(stringOrBuffer.length);
        stringOrBuffer.copy(this.buffer, this.pos);
        this.pos += stringOrBuffer.length;
    }
};

/** Add a field with a preceding space.
 */
RequestFormatter.prototype.addField = function(str) {
    this.ensureSpace(str + 1);
    this.buffer[this.pos++] = 0x20;
    this.pos += this.buffer.write(str, this.pos, undefined, 'ascii');
};

RequestFormatter.prototype.getBuffer = function() {
    return this.buffer.slice(0, this.pos);
};


var MessageParser = function(struct) {
    this.obj = null;
    this.parser = struct.getParser();
    this.tokens = null;
    this.used = 0;
};


/** Parse an array of tokens.
 *
 * Return:
 *  - null if more tokens are needed, otherwise
 *    an array of the remaining, unused tokens.
 *
 * Exceptions:
 *  - ProtocolError: if a unexpected token was encountered.
 */
MessageParser.prototype.parseTokens = function(tokens) {
    if (this.tokens) {
        this.tokens = this.tokens.concat(tokens);
    }
    else {
        this.tokens = tokens;
        this.used = 0;
    }

    var obj = this.parser(this);
    if (obj !== null) {
        // All done
        this.obj = obj;
        return this.used > 0 ? this.tokens.slice(this.used) : this.tokens;
    }
    else {
        // Need more tokens.  Drop the used ones, if all was consumed
        // (slicing otherwise is a bit unnecessary)
        if (this.used === this.tokens.length) {
            this.tokens = null;
            this.used = 0;
        }

        return null;
    }
};

/** Fetch the fully parsed message.
 */
MessageParser.prototype.getMessage = function() {
    return this.obj;
};


/** Used by type parsers to get the next token.
 *
 * Will consume a token, so if the parser relies
 * on multiple tokens being availabe it must first
 * check that with availableTokens().
 *
 * Return:
 *  - Next token, or null if not recieved yet.
 */
MessageParser.prototype.nextToken = function() {
    if (this.used < this.tokens.length) {
        return this.tokens[this.used++];
    }
    else {
        return null;
    }
};


/** Used by type parsers to check how many tokens are available.
 */
MessageParser.prototype.availableTokens = function() {
    return this.tokens.length - this.used;
};


//
// External API
//

/** Format a request for transfer to the server.
 *
 * Parameters:
 *  - name: RPC name
 *  - params: object (not array) of request parameters by name
 *
 * Returns:
 *  - Buffer
 */
exports.formatRequest = function(name, refNo, params) {
    var rpc = rpcDefs[name];

    if (!rpc) {
        throw new Error('unknown RPC name: ' + name);
    }

    var formatter = new RequestFormatter(rpc, refNo, params);
    return formatter.getBuffer();
};



/** Return a parser for a request response.
 *
 * Parameters:
 *  - name: RPC name
 *
 * Return:
 *  - MessageParser
 */
exports.getResponseParser = function(name) {
    var rpc = rpcDefs[name];

    if (!rpc) {
        throw new Error('unknown RPC name: ' + name);
    }

    return new MessageParser(rpc.res);
};

/** Return a parser for a request error.
 *
 * Return:
 *  - MessageParser
 */
exports.getErrorParser = function() {
    return new MessageParser(requestError);
};


/** Return a parser for an async message
 *
 * Parameters:
 *  - number: async number
 *
 * Return:
 *  - MessageParser or null if the number is not known
 */
exports.getAsyncParser = function(number) {
    var async = asyncLookup[number];

    if (!async) {
        return null;
    }

    return new MessageParser(async.msg);
};
