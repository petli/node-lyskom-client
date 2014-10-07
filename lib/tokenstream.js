/* LysKOM protocol A token stream
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var debug = require('debug')('lyskom-client:tokenstream');

var util = require('util');
var events = require('events');

var errors = require('./errors');


/** Construct a new TokenStream.
 *
 * Parameters:
 *
 * - stream: a ReadableStream with no previous data event handlers,
 *   and where setEncoding has not been called.
 *
 * - expectHandshake: if true, expect a protocol handshake form the
 *   server before the tokens start.
 */
var TokenStream = function(stream, expectHandshake) {
    this._stream = stream;

    var self = this;
    var buffer = null;

    var parser = function(nextBuffer) {

        if (buffer) {
            // We expect that most data responses we get from the server to be pretty
            // complete strings, so this buffer copying should not happen too often
            buffer = Buffer.concat([buffer, nextBuffer]);
        }
        else {
            buffer = nextBuffer;
        }

        // Do the basic protocol parsing as ascii, and extract a
        // hollerith-coded string as a buffer slice when we find one

        var data = buffer.toString('ascii');
        var tokens = [];

        while (data) {
            var m, consumed, token;

            // %%Server error
            if ((m = data.match(/^\s*%%(.*)$/m))) {
                // It is sometimes possible to continue after this, so
                // let's not give up.
                consumed = m[0].length;
                data = data.slice(consumed);
                buffer = buffer.slice(consumed);

                debug('parsed %j to server error: %s', m[0], m[1]);

                self.emit('error', new errors.ServerError(m[1]));

                if (expectHandshake) {
                    // Fatal, give up
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('end');
                    buffer = null;

                    // Bail out early
                    return;
                }
            }

            // LysKOM
            else if (expectHandshake) {
                var hs = data.slice(0, 7);

                if (hs !== 'LysKOM\n'.slice(0, hs.length)) {
                    debug('bad server handshake: %j', data);
                    self.emit('error', new errors.ProtocolError('bad server handshake: ' + data));
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('end');
                    buffer = null;

                    // Bail out early
                    return;
                }
                else if (hs.length === 7) {
                    // Got complete handshake
                    debug('got server handshake');
                    self.emit('handshake');
                    expectHandshake = false;
                    data = data.slice(7);
                    buffer = buffer.slice(7);
                }
                else {
                    // Wait for rest of handshake
                    data = '';
                }
            }

            // Normal token parsing flow
            else {

                // Integer
                if ((m = data.match(/^\s*([0-9]+)\s/))) {
                    consumed = m[0].length;

                    token = {
                        type: 'int',
                        string: m[1],
                        value: parseInt(m[1], 10),
                    };
                    debug('parsed %j to %j', m[0], token);

                    tokens.push(token);
                    data = data.slice(consumed);
                    buffer = buffer.slice(consumed);
                }

                // String
                else if ((m = data.match(/^\s*([0-9]+)H/))) {
                    var prefix = m[0].length;
                    var stringLength = parseInt(m[1], 10);
                    consumed = prefix + stringLength;

                    if (consumed <= buffer.length) {
                        token = {
                            type: 'string',
                            value: buffer.slice(prefix, consumed)
                        };

                        debug('parsed %j to %j', m[0], token);
                        tokens.push(token);

                        data = data.slice(consumed);
                        buffer = buffer.slice(consumed);
                    }
                    else {
                        // Incomplete string
                        data = '';
                    }
                }

                // Simple tokens
                else if ((m = data.match(/^\s*([{}*=%:])/))) {
                    consumed = m[0].length;

                    token = { type: m[1], };
                    debug('parsed %j to %j', m[0], token);
                    tokens.push(token);

                    data = data.slice(consumed);
                    buffer = buffer.slice(consumed);
                }

                // Float
                else if ((m = data.match(/^\s*([0-9]+\.[0-9]+)\s/))) {
                    consumed = m[0].length;
                    data = data.slice(consumed);
                    buffer = buffer.slice(consumed);

                    token = {
                        type: 'float',
                        value: parseFloat(m[1]),
                    };
                    debug('parsed %j to %j', m[0], token);

                    tokens.push(token);
                }

                // Partial integers or strings (not terminated by whitespace or H)
                else if (/^\s*[0-9]/.test(data)) {
                    data = '';
                }

                // Unexpected but benign whitespace
                else if (/^\s+$/.test(data)) {
                    data = '';
                    buffer = null;
                }

                // Unknown stuff, give up and don't generate any tokens
                // since things seems to be corrupted
                else {
                    debug('parse error: %s', data);

                    self.emit('error', new errors.ProtocolError('unexpected data from server: ' + data));
                    stream.removeAllListeners('data');
                    stream.removeAllListeners('end');
                    buffer = null;
                    data = '';
                }
            }
        }

        if (tokens.length) {
            self.emit('tokens', tokens);
        }
    };

    stream.on('data', parser);
    stream.on('end', function() {
        if (buffer && buffer.length) {
            // Add whitespace to let any stray stuff be parsed
            parser(new Buffer('\n'));

            // If there's still stuff, something is wrong
            if (buffer && buffer.length) {
                debug('parse error at end of string: %j', buffer);

                self.emit('error', new errors.ProtocolError('bad data at end of stream: ' + buffer.toString()));
            }
        }

        self.emit('end');
    });
};

util.inherits(TokenStream, events.EventEmitter);


/** Event: tokens
 *
 * Emitted when one or more tokens have been parsed.
 *
 * Parameter:
 * - array of tokens
 *
 * Each token is represented as an object with the following
 * properties:
 *
 * - type: 'int', 'float', 'string', '{', '}', '*', '=', '%', ':'
 *
 * - string: the token as a string (only for int, to allow bitstring parsing)
 *
 * - value: the parsed value, if int, float or string.  Strings are
 *          passed as Buffer objects, since the tokenizer don't know
 *          what the encoding might be.
 */

/** Event: end
 *
 * Emitted when the last data from the server has been parsed into
 * tokens.
 */

/** Event: error
 *
 * Emitted on protocol errors.
 *
 * Parameter:
 *  - an error message
 */


/** Pause the underlying stream.
 */
TokenStream.prototype.pause = function() {
    this._stream.pause();
};

/** Resume the underlying stream.
 */
TokenStream.prototype.resume = function() {
    this._stream.resume();
};

module.exports = TokenStream;

