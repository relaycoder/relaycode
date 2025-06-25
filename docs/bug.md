realme-book@realme-book:~/Project/relaycontext$ relay w
✘ [ERROR] Could not resolve "/home/realme-book/Project/relaycontext/src/index.ts" (originally "relaycode")

    relaycode.config.ts:1:29:
      1 │ import { defineConfig } from 'relaycode';
        ╵                              ~~~~~~~~~~~

  The path "relaycode" was remapped to "/home/realme-book/Project/relaycontext/src/index.ts" using
  the alias feature, which then couldn't be resolved. Keep in mind that import path aliases are
  resolved in the current working directory.

file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:3473
    let error = new Error(text);
                ^

Error: Build failed with 1 error:
relaycode.config.ts:1:29: ERROR: Could not resolve "/home/realme-book/Project/relaycontext/src/index.ts" (originally "relaycode")
    at failureErrorWithLog (file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:3473:17)
    at file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:2863:27
    at file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:2809:54
    at buildResponseToResult (file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:2861:9)
    at file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:2890:18
    at responseCallbacks.<computed> (file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:2537:11)
    at handleIncomingPacket (file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:2596:11)
    at Socket.readFromStdout (file:///home/realme-book/.bun/install/global/node_modules/relaycode/dist/cli.js:2513:9)
    at Socket.emit (node:events:518:28)
    at addChunk (node:internal/streams/readable:561:12) {
  errors: [Getter/Setter],
  warnings: [Getter/Setter]
}

Node.js v20.18.1
