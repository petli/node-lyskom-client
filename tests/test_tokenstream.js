/* LysKOM protocol A token stream unit tests
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

/* global describe, it */

var util = require('util');
var events = require('events');
var should = require('should'); // jshint ignore:line
var assert = require('assert');

var TokenStream = require('../lib/tokenstream');


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


describe('TokenStream', function() {
    this.timeout(20);

    it('should emit protocol errors', function(done) {
        var ds = new DummyDataStream(
            ' %%foo bar.'
        );

        var ts = new TokenStream(ds, false);

        ts.on('error', function(err) {
            err.message.should.equal('foo bar.');
            done();
        });

        ts.on('tokens', function(tokens) {
            assert.fail(tokens, [], 'no tokens should be emitted');
        });

        ds.run();
    });


    it('should parse partial integer', function(done) {
        var ds = new DummyDataStream(
            '123', '456'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(1);

            tokens[0].type.should.equal('int');
            tokens[0].raw.toString().should.equal('123456');
            tokens[0].value.should.equal(123456);

            done();
        });

        ds.run();
    });


    it('should parse integers', function(done) {
        var ds = new DummyDataStream(
            ' 0 010  \n4294967295'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(3);

            tokens[0].type.should.equal('int');
            tokens[0].raw.toString().should.equal('0');
            tokens[0].value.should.equal(0);

            // This could be either an int or a bitstring (probably the latter)
            tokens[1].type.should.equal('int');
            tokens[1].raw.toString().should.equal('010');
            tokens[1].value.should.equal(10);

            tokens[2].type.should.equal('int');
            tokens[2].raw.toString().should.equal('4294967295');
            tokens[2].value.should.equal(4294967295);

            done();
        });

        ds.run();
    });


    it('should parse float', function(done) {
        var ds = new DummyDataStream(
            ' \n 12.3456'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(1);

            tokens[0].type.should.equal('float');
            tokens[0].value.should.be.approximately(12.3456, 0.0001);

            done();
        });

        ds.run();
    });


    it('should parse strings', function(done) {
        var ds = new DummyDataStream(
            '  1H0  0H \n 12Hhello\nworld!'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(3);

            tokens[0].type.should.equal('string');
            tokens[0].value.toString().should.equal('0');

            tokens[1].type.should.equal('string');
            tokens[1].value.toString().should.equal('');

            tokens[2].type.should.equal('string');
            tokens[2].value.toString().should.equal('hello\nworld!');

            done();
        });

        ds.run();
    });


    it('should parse partial string', function(done) {
        var ds = new DummyDataStream(
            '12Hhello\n',
            'world!'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(1);

            tokens[0].type.should.equal('string');
            tokens[0].value.toString().should.equal('hello\nworld!');

            done();
        });

        ds.run();
    });


    it('should parse arrays', function(done) {
        var ds = new DummyDataStream(
            '2 { 10 20 }',
            '0 *'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(7);

            tokens[0].type.should.equal('int');
            tokens[0].value.should.equal(2);

            tokens[1].type.should.equal('{');

            tokens[2].type.should.equal('int');
            tokens[2].value.should.equal(10);

            tokens[3].type.should.equal('int');
            tokens[3].value.should.equal(20);

            tokens[4].type.should.equal('}');

            tokens[5].type.should.equal('int');
            tokens[5].value.should.equal(0);

            tokens[6].type.should.equal('*');

            done();
        });

        ds.run();
    });


    it('should parse replies', function(done) {
        var ds = new DummyDataStream(
            '  =203 2Hok'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(3);

            tokens[0].type.should.equal('=');

            tokens[1].type.should.equal('int');
            tokens[1].value.should.equal(203);

            tokens[2].type.should.equal('string');
            tokens[2].value.toString().should.equal('ok');

            done();
        });

        ds.run();
    });


    it('should parse error replies', function(done) {
        var ds = new DummyDataStream(
            '\n %203 10 0'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(4);

            tokens[0].type.should.equal('%');

            tokens[1].type.should.equal('int');
            tokens[1].value.should.equal(203);

            tokens[2].type.should.equal('int');
            tokens[2].value.should.equal(10);

            tokens[3].type.should.equal('int');
            tokens[3].value.should.equal(0);

            done();
        });

        ds.run();
    });


    it('should parse async messages', function(done) {
        var ds = new DummyDataStream(
            ' \n:2 15 4711 1234'
        );

        var ts = new TokenStream(ds, false);
        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(5);

            tokens[0].type.should.equal(':');

            tokens[1].type.should.equal('int');
            tokens[1].value.should.equal(2);

            tokens[2].type.should.equal('int');
            tokens[2].value.should.equal(15);

            tokens[3].type.should.equal('int');
            tokens[3].value.should.equal(4711);

            tokens[4].type.should.equal('int');
            tokens[4].value.should.equal(1234);

            done();
        });

        ds.run();
    });


    it('should handle handshake', function(done) {
        var ds = new DummyDataStream(
            'Lys', 'KOM\n10'
        );

        var ts = new TokenStream(ds, true);

        var tokens = [];

        ts.on('tokens', function(t) {
            tokens = tokens.concat(t);
        });

        ts.on('end', function() {
            tokens.should.have.length(1);

            tokens[0].type.should.equal('int');
            tokens[0].value.should.equal(10);

            done();
        });

        ds.run();
    });


    it('should require handshake', function(done) {
        var ds = new DummyDataStream(
            '10'
        );

        var ts = new TokenStream(ds, true);

        ts.on('error', function(err) {
            err.message.should.startWith('bad server handshake');
            done();
        });

        ts.on('tokens', function(tokens) {
            assert.fail(tokens, [], 'no tokens should be emitted');
        });

        ds.run();
    });


    it('should handle handshake errors', function(done) {
        var ds = new DummyDataStream(
            '%% No connections left.\n'
        );

        var ts = new TokenStream(ds, true);

        ts.on('error', function(err) {
            err.message.should.equal(' No connections left.');
            done();
        });

        ts.on('tokens', function(tokens) {
            assert.fail(tokens, [], 'no tokens should be emitted');
        });

        ds.run();
    });
});
