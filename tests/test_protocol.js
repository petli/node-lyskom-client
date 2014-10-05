/* LysKOM protocol A token stream unit tests
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

// silence errors about "foo.should.be.empty;"
/* jshint -W030 */
/* global describe, it */

var util = require('util');
var events = require('events');
var should = require('should'); // jshint ignore:line
var iconv = require('iconv-lite');

var protocol = require('../lib/protocol');
var TokenStream = require('../lib/tokenstream');


// Use proper message fragments when testing the parser,
// instead of just mocking up the tokens.  This needs
// a bit of helper code

var DummyDataStream = function() {
    this.data = Array.prototype.slice.call(arguments);
};

util.inherits(DummyDataStream, events.EventEmitter);

DummyDataStream.prototype.run = function() {
    for (var i = 0; i < this.data.length; i++) {
        var d = this.data[i];
        if (typeof d === 'string') {
            d = new Buffer(this.data[i], 'ascii');
        }
        this.emit('data', d);
    }
    this.emit('end');
};


var parseTokens = function(ds, callback) {
    var ts = new TokenStream(ds, false);
    var tokens = [];

    ts.on('tokens', function(t) {
        tokens = tokens.concat(t);
    });

    ts.on('end', function() {
        callback(tokens);
    });

    ds.run();
};


describe('protocol', function() {
    this.timeout(20);

    it('should format logout request', function() {
        var buf = protocol.rpc.logout.formatRequest(10, {});
        var str = buf.toString('ascii');

        str.should.equal('10 1\n');
    });


    it('should format login request', function() {
        var buf = protocol.rpc.login.formatRequest(11, {
            person: 4711,
            passwd: 'hämligt',  // will be latin1
            invisible: true,
        });
        var str = iconv.decode(buf, 'latin1');

        str.should.equal('11 62 4711 7Hhämligt 1\n');
    });


    it('should format acceptAsync request', function() {
        var buf = protocol.rpc.acceptAsync.formatRequest(12, {
            requestList: [12, 8, 4]
        });
        var str = buf.toString('ascii');

        str.should.equal('12 80 3 { 12 8 4 }\n');
    });


    it('should parse login response', function(done) {
        // The =refNo has already been handled by the Client object

        parseTokens(new DummyDataStream("10"), function(tokens) {
            tokens.should.have.length(1);

            var parser = protocol.rpc.login.getResponseParser();
            var remaining = parser.parseTokens(tokens);
            var msg = parser.getMessage();

            remaining.should.have.length(1);
            msg.should.be.empty;

            done();
        });
    });


    it('should parse request error', function(done) {
        // The %refNo has already been handled by the Client object

        parseTokens(new DummyDataStream("4 4711"), function(tokens) {
            tokens.should.have.length(2);

            var parser = protocol.rpc.login.getErrorParser();
            var remaining = parser.parseTokens(tokens);
            var msg = parser.getMessage();

            remaining.should.have.length(0);
            msg.errorCode.should.equal(4);
            msg.errorStatus.should.equal(4711);

            done();
        });
    });


    it('should parse request error token by token', function(done) {
        // The %refNo has already been handled by the Client object

        parseTokens(new DummyDataStream("4 4711"), function(tokens) {
            tokens.should.have.length(2);

            var parser = protocol.rpc.login.getErrorParser();
            var remaining1 = parser.parseTokens([tokens[0]]);
            var msg1 = parser.getMessage();

            should(remaining1).equal(null);
            should(msg1).equal(null);

            var remaining2 = parser.parseTokens([tokens[1]]);
            var msg2 = parser.getMessage();

            remaining2.should.have.length(0);
            msg2.errorCode.should.equal(4);
            msg2.errorStatus.should.equal(4711);

            done();
        });
    });

    it('should parse async send-message', function(done) {
        // The :numParams msgNum has already been handled by the Client object

        parseTokens(new DummyDataStream("4711 1234 6Hfoobar"), function(tokens) {
            tokens.should.have.length(3);

            var parser = protocol.async[12].getMessageParser();
            var remaining = parser.parseTokens(tokens);
            var msg = parser.getMessage();

            remaining.should.have.length(0);
            msg.recipient.should.equal(4711);
            msg.sender.should.equal(1234);
            msg.message.toString().should.equal('foobar');

            done();
        });
    });
});

