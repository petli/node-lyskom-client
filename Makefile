
JSHINT = ./node_modules/.bin/jshint

node-js = *.js lib/*.js tests/*.js examples/*.js

test = tests/*.js

MOCHA_FLAGS = 

REPORTER=
ifeq ($(EMACS),t)
REPORTER=--reporter=.jshint-emacs.js
endif

all: lint

clean:

lint:
	$(JSHINT) $(REPORTER) $(node-js)

test:
	./node_modules/.bin/mocha $(MOCHA_FLAGS) $(test)

dist:
	git clean -fx .
	npm pack

.PHONY: all clean lint test dist
