'use strict';

const Promise = require('bluebird');
const LRU = require('lru-cache');
const expect = require('chai').expect;
const tokenDealer = require('../');

// Uncomment to improve debugging
// global.Promise = Promise;
// Promise.config({ longStackTraces: true });

describe('token-dealer', () => {
    let lru;

    beforeEach(() => {
        lru = new LRU();
    });

    it('should return null if no tokens were passed', () => {
        let suppliedToken;

        return tokenDealer(null, (token) => {
            suppliedToken = token;
        }, { lru })
        .then(() => {
            expect(suppliedToken).to.equal(null);

            return tokenDealer([], (token) => {
                suppliedToken = token;
            }, { lru });
        })
        .then(() => {
            expect(suppliedToken).to.equal(null);
        });
    });

    it('should deal tokens, putting aside exhausted ones', () => {
        const tokens = ['A', 'B', 'C', 'D'];
        const suppliedTokens = [];

        // Should give A followed by B
        return tokenDealer(tokens, (token, exhaust) => {
            suppliedTokens.push(token);

            return Promise.delay(50)
            .then(() => {
                if (token === 'A') {
                    exhaust(Date.now() + 2000, true);
                    throw new Error('foo');
                }
            });
        }, { lru })
        .then(() => expect(suppliedTokens).to.eql(['A', 'B']))
        // Should give B since A is exhausted
        .then(() => {
            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
            }, { lru })
            .then(() => expect(suppliedTokens).to.eql(['A', 'B', 'B']));
        })
        // Should give B since A is exhausted
        .then(() => {
            return tokenDealer(tokens, (token, exhaust) => {
                suppliedTokens.push(token);
                return Promise.delay(50)
                .then(() => exhaust(Date.now() + 1000));
            }, { lru })
            .then(() => expect(suppliedTokens).to.eql(['A', 'B', 'B', 'B']));
        })
        // Should give C since A and B is exhausted
        .then(() => {
            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
                return Promise.delay(50);
            }, { lru })
            .then(() => expect(suppliedTokens).to.eql(['A', 'B', 'B', 'B', 'C']));
        })
        // Should give C since A and B is exhausted
        .then(() => {
            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
                return Promise.delay(50);
            }, { lru })
            .then(() => expect(suppliedTokens).to.eql(['A', 'B', 'B', 'B', 'C', 'C']));
        })
        // Should give C since A and B is exhausted
        .then(() => {
            return tokenDealer(tokens, (token, exhaust) => {
                suppliedTokens.push(token);
                return Promise.delay(1100)
                .then(() => exhaust(Date.now() + 3000));
            }, { lru })
            .then(() => expect(suppliedTokens).to.eql(['A', 'B', 'B', 'B', 'C', 'C', 'C']));
        })
        // Should give B, since it is no longer exhausted because enough time has passed
        .then(() => {
            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
            }, { lru })
            .then(() => expect(suppliedTokens).to.eql(['A', 'B', 'B', 'B', 'C', 'C', 'C', 'B']))
            .then(() => Promise.delay(1100));
        })
        // Should give A, since it is no longer exhausted because enough time has passed
        .then(() => {
            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
            }, { lru })
            .then(() => expect(suppliedTokens).to.eql(['A', 'B', 'B', 'B', 'C', 'C', 'C', 'B', 'A']));
        });
    });

    it('should deal tokens, giving less priority to the ones with higher pending count', () => {
        const tokens = ['A', 'B', 'C'];
        const suppliedTokens = [];

        return Promise.all([
            tokenDealer(tokens, (token) => { suppliedTokens.push(token); return Promise.delay(50); }, { lru }),
            tokenDealer(tokens, (token) => { suppliedTokens.push(token); return Promise.delay(50); }, { lru }),
            tokenDealer(tokens, (token) => { suppliedTokens.push(token); return Promise.delay(50); }, { lru }),
            tokenDealer(tokens, (token) => { suppliedTokens.push(token); return Promise.delay(50); }, { lru }),
            tokenDealer(tokens, (token) => { suppliedTokens.push(token); return Promise.delay(50); }, { lru }),
            tokenDealer(tokens, (token) => { suppliedTokens.push(token); return Promise.delay(50); }, { lru }),
        ])
        .then(() => {
            expect(suppliedTokens).to.eql(['A', 'B', 'C', 'A', 'B', 'C']);
        });
    });

    it('should isolate tokens by groups', () => {
        const tokens = ['A', 'B', 'C'];
        const suppliedTokens = [];

        // Should give A
        return tokenDealer(tokens, (token, exhaust) => {
            suppliedTokens.push(token);

            return Promise.delay(50)
            .then(() => exhaust(Date.now() + 1000));
        }, { lru })
        .then(() => expect(suppliedTokens).to.eql(['A']))
        // Should give A because the group is different
        .then(() => {
            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
            }, { group: 'foo' })
            .then(() => expect(suppliedTokens).to.eql(['A', 'A']));
        }, { lru });
    });

    it('should fail if all tokens are exhausted', () => {
        const tokens = ['A', 'B'];
        const suppliedTokens = [];
        const resetTimestamps = [];

        // Should give A followed by B and then fail
        return tokenDealer(tokens, (token, exhaust) => {
            suppliedTokens.push(token);

            return Promise.delay(50)
            .then(() => {
                resetTimestamps.push(Date.now() + 1000);
                exhaust(resetTimestamps[resetTimestamps.length - 1], true);
                throw new Error('foo');
            });
        }, { lru })
        .then(() => {
            throw new Error('Should have failed');
        }, (err) => {
            expect(suppliedTokens).to.eql(['A', 'B']);
            expect(err).to.be.an.instanceOf(Error);
            expect(err.code).to.equal('EALLTOKENSEXHAUSTED');
            expect(err.usage).to.eql({
                A: { exhausted: true, reset: resetTimestamps[0], pending: 0 },
                B: { exhausted: true, reset: resetTimestamps[1], pending: 0 },
            });
            expect(err.errors.length).to.equal(2);
            err.errors.forEach((err) => {
                expect(err).to.be.an.instanceOf(Error);
                expect(err.message).to.equal('foo');
            });
        })
        // Should give A followed by B and then fail
        .then(() => {
            return tokenDealer(tokens, (token, exhaust) => {
                suppliedTokens.push(token);

                return Promise.delay(50)
                .then(() => {
                    resetTimestamps.push(Date.now() + 1000);
                    exhaust(resetTimestamps[resetTimestamps.length - 1], true);
                    throw new Error('foo');
                });
            }, { lru, wait: false });
        })
        .then(() => {
            throw new Error('Should have failed');
        }, (err) => {
            expect(err).to.be.an.instanceOf(Error);
            expect(err.code).to.equal('EALLTOKENSEXHAUSTED');
        });
    });

    it('should not redeal tokens if exhaust is called with fail != true', () => {
        const tokens = ['A', 'B'];
        const suppliedTokens = [];

        // Should give A and then fail
        return tokenDealer(tokens, (token, exhaust) => {
            suppliedTokens.push(token);

            return Promise.delay(50)
            .then(() => {
                exhaust(Date.now() + 1000);
                throw new Error('foo');
            });
        }, { lru })
        .then(() => {
            throw new Error('Should have failed');
        }, (err) => {
            expect(err).to.be.an.instanceOf(Error);
            expect(err.message).to.equal('foo');
        });
    });

    it('should have a default reset if exhausted without a reset timestamp', () => {
        const tokens = ['A'];

        return tokenDealer(tokens, (token, exhaust) => exhaust(), { lru })
        .then(() => {
            const usage = tokenDealer.getTokensUsage(tokens, { lru });
            const expectedReset = Date.now() + 60 * 60 * 1000;

            expect(usage).to.be.an('object');
            expect(usage.A).to.be.an('object');
            expect(usage.A.exhausted).to.equal(true);
            expect(usage.A.reset).to.be.within(expectedReset - 1000, expectedReset + 1000);
        });
    });

    it('should decrease pending if fn fails synchronously', () => {
        const tokens = ['A', 'B'];
        const suppliedTokens = [];

        return tokenDealer(tokens, (token) => {
            suppliedTokens.push(token);
            throw new Error('foo');
        }, { lru })
        .then(() => {
            throw new Error('Should have failed');
        }, (err) => {
            expect(err).to.be.an.instanceOf(Error);
            expect(err.message).to.equal('foo');
            expect(suppliedTokens).to.eql(['A']);
            expect(tokenDealer.getTokensUsage(tokens, { lru })).to.eql({
                A: { exhausted: false, reset: null, pending: 0 },
                B: { exhausted: false, reset: null, pending: 0 },
            });
        });
    });

    it('should wait if all tokens are exhausted when options.wait is true', () => {
        const tokens = ['A'];
        const suppliedTokens = [];

        // Should give A
        return tokenDealer(tokens, (token, exhaust) => {
            suppliedTokens.push(token);

            return Promise.delay(50)
            .then(() => exhaust(Date.now() + 2500));
        }, { lru })
        .then(() => expect(suppliedTokens).to.eql(['A']))
        // Should still give A, but wait 2.5sec
        .then(() => {
            const timeBefore = Date.now();

            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
            }, { lru, wait: true })
            .then(() => {
                expect(Date.now() - timeBefore).to.be.within(2400, 3000);
            });
        })
        .then(() => expect(suppliedTokens).to.eql(['A', 'A']));
    });

    it('should call wait function whenever waiting', () => {
        const tokens = ['A'];
        const suppliedTokens = [];
        const waitDelays = [];
        const wait = (token, delay) => {
            expect(tokens.indexOf(token)).to.not.equal(-1);
            waitDelays.push(delay);
            return true;
        };

        // Should give A
        return tokenDealer(tokens, (token, exhaust) => {
            suppliedTokens.push(token);

            return Promise.delay(50)
            .then(() => exhaust(Date.now() + 600));
        }, { lru, wait })
        .then(() => expect(suppliedTokens).to.eql(['A']))
        // Should still give A, but wait
        .then(() => {
            const timeBefore = Date.now();

            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
            }, { lru, wait })
            .then(() => {
                expect(Date.now() - timeBefore).to.be.within(500, 1200);
                expect(suppliedTokens).to.eql(['A', 'A']);
            });
        })
        .then(() => {
            expect(waitDelays.length).to.equal(1);
            expect(waitDelays[0]).to.be.within(500, 1200);
        });
    });

    it('should use the passed LRU', () => {
        const tokens = ['A'];
        const suppliedTokens = [];

        // Should give A
        return tokenDealer(tokens, (token, exhaust) => {
            suppliedTokens.push(token);

            return Promise.delay(50)
            .then(() => exhaust(Date.now() + 1000));
        }, { lru })
        .then(() => expect(suppliedTokens).to.eql(['A']))
        // Should still give A since another LRU was passed
        .then(() => {
            return tokenDealer(tokens, (token) => {
                suppliedTokens.push(token);
            }, { lru: new LRU() })
            .then(() => expect(suppliedTokens).to.eql(['A', 'A']));
        });
    });

    describe('.getTokensUsage()', () => {
        it('should give the current tokens usage', () => {
            expect(tokenDealer.getTokensUsage(['A', 'B'], { lru })).to.eql({
                A: { exhausted: false, reset: null, pending: 0 },
                B: { exhausted: false, reset: null, pending: 0 },
            });
        });
    });
});