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

var field = function(name, type) {
    return new Field(name, type);
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
        throw new errors.ClientError('Structure require an object: ' + obj);
    }

    for (var i = 0; i < this.fields.length; i++) {
        var f = this.fields[i];
        var v = obj[f.name];

        if (v === undefined && !obj.hasOwnProperty(f.name)) {
            throw new errors.ClientError('missing structure field: ' + f.name);
        }

        try {
            f.type.format(formatter, v);
        }
        catch (err) {
            if (err instanceof errors.ClientError) {
                throw new errors.ClientError('invalid value for ' + f.name + ': ' + err.message);
            }
            else {
                throw err;
            }
        }
    }
};


/** A bitstring of boolean flags, translated into an options-like
 * object.
 */
var Bitstring = function(flags, length) {
    this.flags = flags;

    this.reserved = '';
    for (var i = flags.length; i < length; i++) {
        this.reserved += '0';
    }
};

Bitstring.prototype.getParser = function() {
    return this.parser.bind(this);
};

Bitstring.prototype.parser = function(msg) {
    var t = msg.nextToken();
    if (t) {
        if (t.type !== 'int') {
            throw new errors.ProtocolError('expected int, got ' + t.type + ': ' + t.value);
        }

        var v = {};
        for (var i = 0; i < this.flags.length; i++) {
            var flag = this.flags[i];
            var bit = t.string[i];
            v[flag] = (bit === '1');
        }

        return v;
    }
    else {
        return null;
    }
};

Bitstring.prototype.format = function(formatter, obj) {
    if (typeof obj !== 'object') {
        throw new errors.ClientError('Bitstring require an object: ' + obj);
    }

    var v = '';

    for (var i = 0; i < this.flags.length; i++) {
        var flag = this.flags[i];
        v += obj[flag] ? '1' : '0';
    }

    formatter.addField(v + this.reserved);
};


/** An array of values all of a single type
 */
var KOMArray = function(type) {
    this.type = type;
};

KOMArray.prototype.format = function(formatter, a) {
    if (!Array.isArray(a)) {
        throw new errors.ClientError('must be an array: ' + a);
    }

    formatter.addField(a.length.toString());
    formatter.addField('{');

    for (var i = 0; i < a.length; i++) {
        this.type.format(formatter, a[i]);
    }

    formatter.addField('}');
};

KOMArray.prototype.getParser = function() {
    var type = this.type;
    var length = null;
    var array = null;
    var i = 0;
    var currentParser = null;

    return function(msg) {
        var t;

        if (length === null) {
            t = msg.nextToken();
            if (t) {
                if (t.type !== 'int') {
                    throw new errors.ProtocolError('expected int, got ' + t.type + ': ' + t.value);
                }

                length = t.value;
            }
            else {
                return null;
            }
        }

        if (array === null) {
            t = msg.nextToken();
            if (t) {
                if (t.type === '*') {
                    // length-only array
                    return new Array(length);
                }

                if (t.type !== '{') {
                    throw new errors.ProtocolError('expected {, got ' + t.type + ': ' + t.value);
                }

                array = new Array(length);
            }
            else {
                return null;
            }
        }

        while (i < length) {
            if (!currentParser) {
                currentParser = type.getParser();
            }

            var v = currentParser(msg);
            if (v === null) {
                // Not yet a full parse
                return null;
            }

            array[i] = v;
            currentParser = null;
            i++;
        }

        t = msg.nextToken();
        if (t) {
            if (t.type !== '}') {
                throw new errors.ProtocolError('expected }, got ' + t.type + ': ' + t.value);
            }

            return array;
        }
        else {
            return null;
        }
    };
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
            throw new errors.ClientError('invalid value for int: ' + v);
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


var KOMString = {
    getParser: function() {
        return KOMString.parser;
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
            throw new errors.ClientError('invalid string value: ' + v);
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
    int16 = int,
    //int8 = int,
    confNo = int16,
    persNo = confNo,
    localTextNo = int32,
    garbNice = int32,
    textNo = int32,
    sessionNo = int32;

var bool = function(name) { return new Field(name, Bool); };

var string = function(name) { return new Field(name, KOMString); };

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
    this.ensureSpace(str.length + 1);
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

// Common types

var AuxItemFlags = new Bitstring(
    ['deleted', 'inherit', 'secret', 'hideCreator', 'dontGarb'], 8);

var AuxItemInput = new Structure(int32('tag'),
                                 field('flags', AuxItemFlags),
                                 int32('inheritLimit'),
                                 string('data'));

var ConfType = new Bitstring([
    'rdProt',
    'original',
    'secret',
    'letterbox'], 4);

var ConfZInfo = new Structure(string('name'),
                              field('type', ConfType),
                              confNo('confNo'));

var ExtendedConfType = new Bitstring([
    'rdProt',
    'original',
    'secret',
    'letterbox',
    'allowAnonymous',
    'forbidSecret'], 8);

var PersonalFlags = new Bitstring(['unreadIsSecret'], 8);

var Time = new Structure(int32('seconds'),
                         int32('minutes'),
                         int32('hours'),
                         int32('day'),
                         int32('month'),
                         int32('year'),
                         int32('dayOfWeek'),
                         int32('dayOfYear'),
                         bool('isDST'));




// RPC definitions

RPC.error = new Structure(int32('errorCode'), int32('errorStatus'));

exports.rpc = {
    acceptAsync: new RPC(
        80,
        new Structure(array('requestList', Int)),
        Empty
    ),

/*
add-comment [32] (( text-no    : Text-No;
                    comment-to : Text-No ))
    -> (  );

add-footnote [37] (( text-no    : Text-No;
                     footnote-to : Text-No ))
    -> (  );

add-member [100] (( conf-no    : Conf-No;
                    pers-no    : Pers-No;
                    priority   : INT8;
                    where      : INT16;
                    type       : Membership-Type ))
    -> (  );

add-recipient [30] (( text-no    : Text-No;
                      conf-no    : Conf-No;
                      recpt-type : Info-Type ))
    -> (  );

change-conference [2] ( conference : Conf-No )
    -> (  );

change-name [3] (( conference : Conf-No;
                   new-name   : HOLLERITH ))
    -> (  );

change-what-i-am-doing [4] ( what-am-i-doing : HOLLERITH )
    -> (  );

create-anonymous-text [87] (( text       : HOLLERITH;
                              misc-info  : ARRAY Misc-Info;
                              aux-items  : ARRAY Aux-Item-Input ))
    -> ( Text-No );

create-conf [88] (( name       : HOLLERITH;
                    type       : Any-Conf-Type;
                    aux-items  : ARRAY Aux-Item-Input ))
    -> ( Conf-No );

*/

    createPerson: new RPC(
        89,
        new Structure(string('name'),
                      string('passwd'),
                      field('flags', PersonalFlags),
                      array('auxItems', AuxItemInput)),
        Int),

/*
create-text [86] (( text       : HOLLERITH;
                    misc-info  : ARRAY Misc-Info;
                    aux-items  : ARRAY Aux-Item-Input ))
    -> ( Text-No );

delete-conf [11] ( conf : Conf-No )
    -> (  );

delete-text [29] ( text : Text-No )
    -> (  );

disconnect [55] ( session-no : Session-No )
    -> (  );

enable [42] ( level : INT8 )
    -> (  );

find-next-conf-no [116] ( start : Conf-No )
    -> ( Conf-No );

find-next-text-no [60] ( start : Text-No )
    -> ( Text-No );

find-previous-conf-no [117] ( start : Conf-No )
    -> ( Conf-No );

find-previous-text-no [61] ( start : Text-No )
    -> ( Text-No );

first-unused-conf-no [114] ( )
    -> ( Conf-No );

first-unused-text-no [115] ( )
    -> ( Text-No );

get-boottime-info [113] ( )
    -> ( Static-Server-Info );

get-client-name [70] ( session : Session-No )
    -> ( HOLLERITH );

get-client-version [71] ( session : Session-No )
    -> ( HOLLERITH );

get-collate-table [85] ( )
    -> ( HOLLERITH );

get-conf-stat [91] ( conf-no : Conf-No )
    -> ( Conference );

get-info [94] ( )
    -> ( Info );

get-last-text [58] ( before : Time )
    -> ( Text-No );

get-marks [23] ( )
    -> ( ARRAY Mark );

get-members [101] (( conf       : Conf-No;
                     first      : INT16;
                     no-of-members : INT16 ))
    -> ( ARRAY Member );

get-membership [108] (( person     : Pers-No;
                        first      : INT16;
                        no-of-confs : INT16;
                        want-read-ranges : BOOL;
                        max-ranges : INT32 ))
    -> ( ARRAY Membership );

get-person-stat [49] ( pers-no : Pers-No )
    -> ( Person );

get-static-session-info [84] ( session-no : Session-No )
    -> ( Static-Session-Info );

get-stats [112] ( what : HOLLERITH )
    -> ( ARRAY Stats );

get-stats-description [111] ( )
    -> ( Stats-Description );

get-text [25] (( text       : Text-No;
                 start-char : INT32;
                 end-char   : INT32 ))
    -> ( HOLLERITH );

get-text-stat [90] ( text-no : Text-No )
    -> ( Text-Stat );
*/

    getTime: new RPC(35, Empty, Time),

    getUconfStat: new RPC(
        78,
        new Structure(confNo('conference')),
        new Structure(string('name'),
                      field('type', ExtendedConfType),
                      localTextNo('highestLocalNo'),
                      garbNice('nice'))
    ),

/*
get-unread-confs [52] ( pers-no : Pers-No )
    -> ( ARRAY Conf-No );
*/

    getVersionInfo: new RPC(
        75, Empty,
        new Structure(int32('protocolVersion'),
                      string('serverSoftware'),
                      string('softwareVersion'))
    ),

/*
local-to-global [103] (( conf-no    : Conf-No;
                         first-local-no : Local-Text-No;
                         no-of-existing-texts : INT32 ))
    -> ( Text-Mapping );

local-to-global-reverse [121] (( conf-no    : Conf-No;
                                 local-no-ceiling : Local-Text-No;
                                 no-of-existing-texts : INT32 ))
    -> ( Text-Mapping );
*/

    login: new RPC(
        62,
        new Structure(persNo('person'),
                      string('passwd'),
                      bool('invisible')),
        Empty
    ),

    logout: new RPC(1, Empty, Empty),

    lookupZName: new RPC(
        76,
        new Structure(string('name'),
                      bool('wantPersons'),
                      bool('wantConfs')),
        new KOMArray(ConfZInfo)
    ),

/*
map-created-texts [104] (( author     : Pers-No;
                           first-local-no : Local-Text-No;
                           no-of-existing-texts : INT32 ))
    -> ( Text-Mapping );

map-created-texts-reverse [122] (( author     : Pers-No;
                                   local-no-ceiling : Local-Text-No;
                                   no-of-existing-texts : INT32 ))
    -> ( Text-Mapping );

mark-as-read [27] (( conference : Conf-No;
                     text       : ARRAY Local-Text-No ))
    -> (  );

mark-as-unread [109] (( conference : Conf-No;
                        text       : Local-Text-No ))
    -> (  );

mark-text [72] (( text       : Text-No;
                  mark-type  : INT8 ))
    -> (  );

modify-conf-info [93] (( conf       : Conf-No;
                         delete     : ARRAY Aux-No;
                         add        : ARRAY Aux-Item-Input ))
    -> (  );

modify-system-info [95] (( items-to-delete : ARRAY Aux-No;
                           items-to-add : ARRAY Aux-Item-Input ))
    -> (  );

modify-text-info [92] (( text       : Text-No;
                         delete     : ARRAY Aux-No;
                         add        : ARRAY Aux-Item-Input ))
    -> (  );

query-async [81] ( )
    -> ( ARRAY INT32 );

query-predefined-aux-items [96] ( )
    -> ( ARRAY INT32 );

query-read-texts [107] (( person     : Pers-No;
                          conference : Conf-No;
                          want-read-ranges : BOOL;
                          max-ranges : INT32 ))
    -> ( Membership );

*/

    reZLookup: new RPC(
        74,
        new Structure(string('regexp'),
                      bool('wantPersons'),
                      bool('wantConfs')),
        new KOMArray(ConfZInfo)
    ),

    sendMessage: new RPC(
        53,
        new Structure(confNo('recipient'),
                      string('message')),
        Empty
    ),

/*
set-client-version [69] (( client-name : HOLLERITH;
                           client-version : HOLLERITH ))
    -> (  );

set-conf-type [21] (( conf-no    : Conf-No;
                      type       : Any-Conf-Type ))
    -> (  );

set-connection-time-format [120] ( use-utc : BOOL )
    -> (  );

set-etc-motd [17] (( conf-no    : Conf-No;
                     text-no    : Text-No ))
    -> (  );

set-garb-nice [22] (( conf-no    : Conf-No;
                      nice       : Garb-Nice ))
    -> (  );

set-info [79] ( info : Info-Old )
    -> (  );

set-keep-commented [105] (( conf-no    : Conf-No;
                            keep-commented : Garb-Nice ))
    -> (  );

set-last-read [77] (( conference : Conf-No;
                      last-read  : Local-Text-No ))
    -> (  );

set-membership-type [102] (( pers       : Pers-No;
                             conf       : Conf-No;
                             type       : Membership-Type ))
    -> (  );

set-motd-of-lyskom [41] ( text-no : Text-No )
    -> (  );

set-passwd [8] (( person     : Pers-No;
                  old-pwd    : HOLLERITH;
                  new-pwd    : HOLLERITH ))
    -> (  );

set-permitted-submitters [19] (( conf-no    : Conf-No;
                                 perm-sub   : Conf-No ))
    -> (  );

set-pers-flags [106] (( pers-no    : Pers-No;
                        flags      : Personal-Flags ))
    -> (  );

set-presentation [16] (( conf-no    : Conf-No;
                         text-no    : Text-No ))
    -> (  );

set-priv-bits [7] (( person     : Pers-No;
                     privileges : Priv-Bits ))
    -> (  );

set-read-ranges [110] (( conference : Conf-No;
                         read-ranges : ARRAY Read-Range ))
    -> (  );

set-super-conf [20] (( conf-no    : Conf-No;
                       super-conf : Conf-No ))
    -> (  );

set-supervisor [18] (( conf-no    : Conf-No;
                       admin      : Conf-No ))
    -> (  );

set-unread [40] (( conf-no    : Conf-No;
                   no-of-unread : INT32 ))
    -> (  );

set-user-area [57] (( pers-no    : Pers-No;
                      user-area  : Text-No ))
    -> (  );

shutdown-kom [44] ( exit-val : INT8 )
    -> (  );

sub-comment [33] (( text-no    : Text-No;
                    comment-to : Text-No ))
    -> (  );

sub-footnote [38] (( text-no    : Text-No;
                     footnote-to : Text-No ))
    -> (  );

sub-member [15] (( conf-no    : Conf-No;
                   pers-no    : Pers-No ))
    -> (  );

sub-recipient [31] (( text-no    : Text-No;
                      conf-no    : Conf-No ))
    -> (  );

sync-kom [43] ( )
    -> (  );

unmark-text [73] ( text-no : Text-No )
    -> (  );

user-active [82] ( )
    -> (  );

who-am-i [56] ( )
    -> ( Session-No );

who-is-on-dynamic [83] (( want-visible : BOOL;
                          want-invisible : BOOL;
                          active-last : INT32 ))
    -> ( ARRAY Dynamic-Session-Info );
*/
};

exports.async = {
    12: new Async('send-message',
                  new Structure(confNo('recipient'),
                                persNo('sender'),
                                string('message'))),

/*
async-deleted-text [14] (( text-no    : Text-No;
                           text-stat  : Text-Stat ))

async-i-am-on [6] ( info : Who-Info )
*/

    8: new Async('leave-conf',
                 new Structure(confNo('confNo'))),

    9: new Async('login',
                 new Structure(persNo('persNo'),
                               sessionNo('sessionNo'))),

    13: new Async('logout',
                 new Structure(persNo('persNo'),
                               sessionNo('sessionNo'))),

    18: new Async('new-membership',
                  new Structure(persNo('persNo'),
                                confNo('confNo'))),

    21: new Async('new-motd',
                  new Structure(confNo('confNo'),
                                textNo('oldMotd'),
                                textNo('newMotd'))),

    5: new Async('new-name',
                 new Structure(confNo('confNo'),
                               string('oldName'),
                               string('newName'))),

    20: new Async('new-presentation',
                  new Structure(confNo('confNo'),
                                textNo('oldPresentation'),
                                textNo('newPresentation'))),

/*
async-new-recipient [16] (( text-no    : Text-No;
                            conf-no    : Conf-No;
                            type       : Info-Type ))

async-new-text [15] (( text-no    : Text-No;
                       text-stat  : Text-Stat ))
*/

    19: new Async('new-user-area',
                  new Structure(persNo('persNo'),
                                textNo('oldUserArea'),
                                textNo('newUserArea'))),

    11: new Async('rejected-connection', Empty),

/*
async-sub-recipient [17] (( text-no    : Text-No;
                            conf-no    : Conf-No;
                            type       : Info-Type ))
*/

    7: new Async('sync-db', Empty),

/*
async-text-aux-changed [22] (( text-no    : Text-No;
                               deleted    : ARRAY Aux-Item;
                               added      : ARRAY Aux-Item ))
*/
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

exports.aux = {
    contentType: 1,
    fastReply: 2,
    crossReference: 3,
    noComments: 4,
    personalComment: 5,
    requestConfirmation: 6,
    readConfirm: 7,
    redirect: 8,
    xFace: 9,
    alternateName: 10,
    pgpSignature: 11,
    pgpPublicKey: 12,
    emailAddress: 13,
    faqText: 14,
    creatingSoftware: 15,
    mxAuthor: 16,
    mxFrom: 17,
    mxReplyTo: 18,
    mxTo: 19,
    mxCc: 20,
    mxDate: 21,
    mxMessageId: 22,
    mxInReplyTo: 23,
    mxMisc: 24,
    mxAllowFilter: 25,
    mxRejectForward: 26,
    notifyComments: 27,
    faqForConf: 28,
    recommendedConf: 29,
    allowedContentType: 30,
    canonicalName: 31,
    mxListName: 32,
    sendCommentsTo: 33,
    worldReadable: 34,
    mxRefuseImport: 35,
    mxMimeBelongsTo: 10100,
    mxMimePartIn: 10101,
    mxMimeMisc: 10102,
    mxEnvelopeSender: 10103,
    mxMimeFileName: 10104,
};
