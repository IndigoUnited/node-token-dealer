'use strict';

const LRU = require('lru-cache');

const defaultLru = new LRU({ max: 500 });

function retrieveTokenUsage(token, options) {
    const key = `${options.group}#${token}`;

    let tokenUsage = options.lru.get(key);

    if (!tokenUsage || (tokenUsage.exhausted && Date.now() >= tokenUsage.reset)) {
        tokenUsage = { exhausted: false, reset: null, pending: 0 };
        options.lru.set(key, tokenUsage);
    }

    return tokenUsage;
}

function chooseToken(tokens, options) {
    const tokensUsage = getTokensUsage(tokens, options);

    const chosenTokenIndex = tokens.reduce((chosenTokenIndex, token, tokenIndex) => {
        const chosenTokenUsage = tokensUsage[tokens[chosenTokenIndex]];
        const tokenUsage = tokensUsage[token];

        // If both are exhausted, prefer the one that resets sooner
        if (chosenTokenUsage.exhausted && tokenUsage.exhausted) {
            return chosenTokenUsage.reset <= tokenUsage.reset ? chosenTokenIndex : tokenIndex;
        }

        // Prefer the token that is not exhausted
        if (chosenTokenUsage.exhausted && !tokenUsage.exhausted) {
            return tokenIndex;
        }
        if (!chosenTokenUsage.exhausted && tokenUsage.exhausted) {
            return chosenTokenIndex;
        }

        // If both ARE NOT exhausted, prefer the one with less pending requests
        return chosenTokenUsage.pending <= tokenUsage.pending ? chosenTokenIndex : tokenIndex;
    }, 0);

    const chosenToken = tokens[chosenTokenIndex];
    const chosenTokenUsage = tokensUsage[chosenToken];

    return {
        token: chosenToken,
        usage: chosenTokenUsage,
        overallUsage: tokensUsage,
    };
}

function dealToken(tokens, fn, options, errors) {
    const chosen = chooseToken(tokens, options);

    if (chosen.usage.exhausted) {
        const waitTime = chosen.usage.reset - Date.now();
        const shouldWait = typeof options.wait === 'function' ? options.wait(chosen.token, waitTime) : !!options.wait;

        if (!shouldWait) {
            return Promise.reject(Object.assign(new Error('All tokens are exhausted'), {
                code: 'EALLTOKENSEXHAUSTED',
                usage: chosen.overallUsage,
                errors,
            }));
        }

        return new Promise((resolve) => setTimeout(resolve, waitTime))
        .then(() => dealToken(tokens, fn, options, errors));
    }

    chosen.usage.pending += 1;
    let retryOnFailure = false;

    return Promise.resolve()
    .then(() => {
        return fn(chosen.token, (reset, failed) => {
            retryOnFailure = !!failed;
            chosen.usage.exhausted = true;
            chosen.usage.reset = reset || Date.now() + 60 * 60 * 1000;
        });
    })
    .then((val) => {
        chosen.usage.pending -= 1;
        return val;
    }, (err) => {
        chosen.usage.pending -= 1;

        if (retryOnFailure) {
            errors.push(err);
            return dealToken(tokens, fn, options, errors);
        }

        throw err;
    });
}

// ----------------------------------------------------

function tokenDealer(tokens, fn, options) {
    if (!tokens || !tokens.length) {
        return Promise.resolve()
        .then(() => fn(null, () => {}));
    }

    options = Object.assign({
        group: 'default',
        wait: false,
        lru: defaultLru,
    }, options);

    return dealToken(tokens, fn, options, []);
}

function getTokensUsage(tokens, options) {
    options = Object.assign({
        group: 'default',
        lru: defaultLru,
    }, options);

    const tokensUsage = {};

    tokens.forEach((token) => {
        tokensUsage[token] = retrieveTokenUsage(token, options);
    });

    return tokensUsage;
}

module.exports = tokenDealer;
module.exports.getTokensUsage = getTokensUsage;