/* LysKOM protocol A protocol unit tests
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

// silence errors about "foo.should.be.empty;"
/* jshint -W030 */

// silence errors about wrapping functions in parens
/* jshint -W068 */

/* global describe, it */

var util = require('util');
var events = require('events');
var should = require('should'); // jshint ignore:line
var iconv = require('iconv-lite');

var errors = require('../lib/errors');
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


    it('should format createPerson request', function() {
        // Exercises bitstrings and arrays of structs

        var buf = protocol.rpc.createPerson.formatRequest(13, {
            name: 'foo',
            passwd: 'bar',
            flags: { unreadIsSecret: true },
            auxItems: [
                { tag: 17, flags: { inherit: true, dontGarb: true }, inheritLimit: 0, data: 'gazonk' },
                { tag: 18, flags: {}, inheritLimit: 10, data: '' }]
        });
        var str = buf.toString('ascii');

        str.should.equal('13 89 3Hfoo 3Hbar 10000000 2 { ' +
                         '17 01001000 0 6Hgazonk ' +
                         '18 00000000 10 0H }\n');
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

    it('should parse getUconfStat response', function(done) {
        // Exercises bitstring parsing

        parseTokens(new DummyDataStream("3Hfoo 01001100 12000 30"), function(tokens) {
            tokens.should.have.length(4);

            var parser = protocol.rpc.getUconfStat.getResponseParser();
            var remaining = parser.parseTokens(tokens);
            var msg = parser.getMessage();

            remaining.should.have.length(0);

            msg.name.toString().should.equal('foo');

            msg.type.should.be.Object;
            msg.type.rdProt.should.be.false;
            msg.type.original.should.be.true;
            msg.type.secret.should.be.false;
            msg.type.letterbox.should.be.false;
            msg.type.allowAnonymous.should.be.true;
            msg.type.forbidSecret.should.be.true;

            msg.highestLocalNo.should.equal(12000);
            msg.nice.should.equal(30);

            done();
        });
    });

    it('should parse lookupZName response', function(done) {
        // Exercises array parsing

        parseTokens(new DummyDataStream('2 { 3Hfoo 1001 4711 3Hfie 0100 4712 }\n10\n'), function(tokens) {
            tokens.should.have.length(10);

            var parser = protocol.rpc.lookupZName.getResponseParser();

            // Split parsing to check that it survives that
            var remaining = parser.parseTokens(tokens.slice(0, 1));
            should(remaining).equal(null);

            remaining = parser.parseTokens(tokens.slice(1, 3));
            should(remaining).equal(null);

            remaining = parser.parseTokens(tokens.slice(3));
            remaining.should.have.length(1);

            var msg = parser.getMessage();

            msg.should.have.length(2);

            msg[0].name.toString().should.equal('foo');
            msg[0].type.rdProt.should.be.true;
            msg[0].type.original.should.be.false;
            msg[0].type.secret.should.be.false;
            msg[0].type.letterbox.should.be.true;
            msg[0].confNo.should.equal(4711);

            msg[1].name.toString().should.equal('fie');
            msg[1].type.rdProt.should.be.false;
            msg[1].type.original.should.be.true;
            msg[1].type.secret.should.be.false;
            msg[1].type.letterbox.should.be.false;
            msg[1].confNo.should.equal(4712);

            done();
        });
    });

    it('should parse empty lookupZName response', function(done) {
        parseTokens(new DummyDataStream('0 *\n10\n'), function(tokens) {
            tokens.should.have.length(3);

            var parser = protocol.rpc.lookupZName.getResponseParser();
            var remaining = parser.parseTokens(tokens);
            var msg = parser.getMessage();

            remaining.should.have.length(1);

            msg.should.have.length(0);

            done();
        });
    });

    it('should fail on truncated array', function(done) {
        parseTokens(new DummyDataStream("2 { 3Hfoo 1001 4711 }\n"), function(tokens) {
            tokens.should.have.length(6);

            var parser = protocol.rpc.lookupZName.getResponseParser();

            (function() {
                parser.parseTokens(tokens);
            }).should.throw(errors.ProtocolError);

            done();
        });
    });

    it('should fail on too long array', function(done) {
        parseTokens(new DummyDataStream("0 { 3Hfoo 1001 4711 }\n"), function(tokens) {
            tokens.should.have.length(6);

            var parser = protocol.rpc.lookupZName.getResponseParser();

            (function() {
                parser.parseTokens(tokens);
            }).should.throw(errors.ProtocolError);

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

