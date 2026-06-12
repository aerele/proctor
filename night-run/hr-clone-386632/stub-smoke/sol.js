'use strict';

const fs = require('fs');

process.stdin.resume();
process.stdin.setEncoding('utf-8');

let inputString = '';
let currentLine = 0;

process.stdin.on('data', function(inputStdin) {
    inputString += inputStdin;
});

process.stdin.on('end', function() {
    inputString = inputString.split('\n');

    main();
});

function readLine() {
    return inputString[currentLine++];
}

/*
 * Complete the 'minCoins' function below.
 *
 * The function is expected to return an INTEGER.
 * The function accepts INTEGER n as parameter.
 */

function minCoins(n) {
    let c=0; for (const d of [25,10,5,1]) { c += Math.floor(n/d); n %= d; } return c;
}

function main() {
    const ws = { write: (s) => process.stdout.write(s), end: () => {} };

    const n = parseInt(readLine().trim(), 10);

    const result = minCoins(n);

    ws.write(result + '\n');

    ws.end();
}
