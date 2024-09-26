# medic-replay-freetext-search

Experimental script to parse queries from CouchDB logs and replay them on different CouchDB instances to compare how the responses may differ.

## How to use

Install the dependencies
```sh
npm ci
```

Tweak the hardcoded parameters in [`config.ts`](./config.ts)

Run the script
```
./main.ts # or npm start
```

Diffs of the responses will be printed in your terminal.  
Each response will be written to its own JSON file in its respective directory `./responses/${query}`