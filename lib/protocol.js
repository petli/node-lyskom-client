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
// Protocol parsing and generating support classes
//

var RequestFormatter = function(rpc, refNo, params) {
    // Most messages should fit into this
    this.buffer = new Buffer(1000);
    this.pos = 0;

    // Requests start with the reference number and the request number
    this.write(refNo.toString());
    this.addField(rpc.number.toString());

    rpc.request.format(this, params);

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


/** Definition of one RPC in the protocol
 */
var RPC = function(number, req, res) {
    this.number = number;
    this.request = req;
    this.response = res;
};

/** Format a request for transfer to the server.
 *
 * Parameters:
 *  - refNo: Request reference number
 *  - params: object (not array) of request parameters by name
 *
 * Returns:
 *  - Buffer
 */
RPC.prototype.formatRequest = function(refNo, params) {
    var formatter = new RequestFormatter(this, refNo, params);
    return formatter.getBuffer();
};


/** Return a parser for a request response.
 *
 * Return:
 *  - MessageParser
 */
RPC.prototype.getResponseParser = function() {
    return new MessageParser(this.response);
};


/** Return an error response parser
 *
 * Return:
 *  - MessageParser
 */
RPC.prototype.getErrorParser = function() {
    return new MessageParser(RPC.error);
};



/** Definition of one async message in the protocol
 */
var Async = function(name, msg) {
    this.name = name;
    this.msg = msg;
};

/** Return a parser for an async message
 *
 * Return:
 *  - MessageParser
 */
Async.prototype.getMessageParser = function() {
    return new MessageParser(this.msg);
};


//
// Finally, the protocol definitions
//

RPC.error = new Structure(int32('errorCode'), int32('errorStatus'));

exports.rpc = {
    acceptAsync: new RPC(
        80,
        new Structure(array('requestList', Int)),
        Empty
    ),

    login: new RPC(
        62,
        new Structure(persNo('person'),
                      string('passwd'),
                      bool('invisible')),
        Empty
    ),

    logout: new RPC(1, Empty, Empty),

    sendMessage: new RPC(
        53,
        new Structure(confNo('recipient'),
                      string('message')),
        Empty
    ),
};

exports.async = {
    12: new Async('send-message',
                  new Structure(confNo('recipient'),
                                persNo('sender'),
                                string('message'))),
};

exports.errorCodes = {
    0: 'no-error',
    2: 'not-implemented',
    3: 'obsolete-call',
    4: 'invalid-password',
    5: 'string-too-long',
    6: 'login-first',
    7: 'login-disallowed',
    8: 'conference-zero',
    9: 'undefined-conference',
    10: 'undefined-person',
    11: 'access-denied',
    12: 'permission-denied',
    13: 'not-member',
    14: 'no-such-text',
    15: 'text-zero',
    16: 'no-such-local-text',
    17: 'local-text-zero',
    18: 'bad-name',
    19: 'index-out-of-range',
    20: 'conference-exists',
    21: 'person-exists',
    22: 'secret-public',
    23: 'letterbox',
    24: 'ldb-error',
    25: 'illegal-misc',
    26: 'illegal-info-type',
    27: 'already-recipient',
    28: 'already-comment',
    29: 'already-footnote',
    30: 'not-recipient',
    31: 'not-comment',
    32: 'not-footnote',
    33: 'recipient-limit',
    34: 'comment-limit',
    35: 'footnote-limit',
    36: 'mark-limit',
    37: 'not-author',
    38: 'no-connect',
    39: 'out-of-memory',
    40: 'server-is-crazy',
    41: 'client-is-crazy',
    42: 'undefined-session',
    43: 'regexp-error',
    44: 'not-marked',
    45: 'temporary-failure',
    46: 'long-array',
    47: 'anonymous-rejected',
    48: 'illegal-aux-item',
    49: 'aux-item-permission',
    50: 'unknown-async',
    51: 'internal-error',
    52: 'feature-disabled',
    53: 'message-not-sent',
    54: 'invalid-membership-type',
    55: 'invalid-range',
    56: 'invalid-range-list',
    57: 'undefined-measurement',
    58: 'priority-denied',
    59: 'weight-denied',
    60: 'weight-zero',
    61: 'bad-bool',
};
