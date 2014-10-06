/* LysKOM protocol A example: chat through messages
 *
 * Copyright 2014 Peter Liljenberg <peter.liljenberg@gmail.com>
 *
 * Distributed under an MIT license, please see LICENSE in the top dir.
 */

'use strict';

var readline = require('readline');
var iconv = require('iconv-lite');

var lyskom = require('../index.js');

var argv = require('yargs')
    .demand('server').string('server')
    .demand('from')
    .demand('to')
    .argv;

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


var onError = function(err) {
    console.error('Error: %s', err);
};

var onClose = function() {
    console.error('Connection closed.');
    process.exit(0);
};

console.log('Connecting to %s', argv.server);
lyskom.connectAndWait({host: argv.server})
    .then(function(client) {

        client.on('error', onError);
        client.on('close', onClose);

        client.on('send-message', function(msg) {
            // messages are generally in latin1
            console.log('\n%s->%s: %s', msg.sender, msg.recipient,
                        iconv.decode(msg.message, 'latin1'));

            // Restart prompt
            rl.prompt();
        });

        var onReadLine = function(line) {
            // Conform to sending messages as latin1
            client.sendMessage({
                recipient: argv.to,
                message: iconv.encode(line, 'latin1')
            })
                .then(function() {
                    console.log('Message sent.');
                    rl.prompt();
                })
                .error(function(err) {
                    console.error('Error sending message: %s', err);
                    rl.prompt();
                })
                .catch(function(err) {
                    // If this is critical it will also trigger an error event
                    console.error('Exception sending message: %s', err);
                    rl.prompt();
                });
        };

        // Ask for password, then log in and ask to recieve async messages
        rl.question('Password (WILL BE ECHOED): ', function(password) {
            client.login({
                person: argv.from,
                passwd: password,
                invisible: false
            }).then(
                function() {
                    return client.acceptAsync({
                        requestList: [lyskom.async.sendMessage]
                    });
                }
            ).then(
                function() {
                    console.log('Successfully logged in');

                    // Kick off chat
                    rl.setPrompt('Say: ', 5);
                    rl.on('line', onReadLine);
                    rl.prompt();
                }
            ).catch(
                function(err) {
                    console.error('Error logging in: %s', err);
                    process.exit(1);
                });
        });
    }).catch(function(err) {
        console.error('Error connecting to server: %s', err);
        process.exit(1);
    });


