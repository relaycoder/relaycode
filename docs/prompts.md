Code changes rules

1. make sure to isolate every files code block with ```typescript // {filePath} ...{content} ```
2. only write new/affected files changes of a codebase. ignore unnaffected
3. Always write full source code per file
4. if you need to delete file, use ```typescript // {filePath} ↵ //TODO: delete this file ```

_______________________

1. the name should be relaycode
2. well CLI ing.. is tiring.

so

I want the program is as simply installed globally.
then, when programmer opening project in editor and open terminal, 
they simply type , 

`relay --init`

it will auto; 
    2.1. create relaycode.config.json for the project
    2.2. auto prepare initial state on .relaycode dir (for state management especially )
    ```
the config contain
    - projectId : autofill by taking project root dir name
    - approval : yes/no
    - approvalOnErrorCount: for approval yes, how many linter error addition needed to ask for approval 
    - preCommand :
    - postCommand : 
    - linter : custom command, like  `bun tsc -b --noEmit`. if empty, then no need linter checking
    - clipboardPoolInterval :
    ```
    2.3 the program tell user to fill their llm system prompt with following

    ```
    Code changes rules 1-6

1. make sure to isolate every files code block with
  ```typescript // {filePath} 
  ↵
    // START
    ↵
  {content}
  ↵
    // END
  ```
2. only write new/affected files changes of a codebase. ignore unnaffected
3. Always write full source code per file
4. add {your step reasoning} before code block as you progresses
5. if you need to delete file, use 

```typescript // {filePath} 
↵ 
//TODO: delete this file 
↵
```
6. always add below yaml at the end of your response

```yaml
projectId: todo-app <- use this exatcly
uuid: (random uuid)
changeSummary:
  - edit src/main.ts
  - edit src/main.tsx
  - new src/main.ts
  - delete src/main.ts
  - .... (so on)
```
    
    ```

after 2.1 & 2.2 above, the program always watching clipboard for trigger content that contains this yaml schema 

```yaml
projectId: projectname
uuid: a8098c1a-f86e-11da-bd17-00112444be1e
changeSummary:
  - edit src/main.ts
  - edit src/main.tsx
  - new src/main.ts
  - delete src/main.ts
```

if triggered, then applying changes automatically
so the user doesnt need to write md file. 

- the apply rule are follows;
    1. if uuid based on .relaycode says has ever been applied. then it skip
    2. if contain `//TODO: delete this file ` it really delete the file automatically
    3. also it auto delete //START line and //END line and // {filePath} so the file code clean
    4. if user decide to revert. then everything revert at previous state based on .relaycode


 I want the program keep ongoing . I also want the .relaycode files in yaml format along with  snapshots and {your step reasoning}, with readable summary at beginning of files. no daemon please


 ________________________________________________


 create the relaycode project using above requirements by following Code changes rules 887 and
- use bun.sh
- e2e type safety
- HOF
- immutability
- no any/unknown type.


_____________________________________________

which are from below requirement has not met?

________________________________________________

1. while addressing fail tests, always have a mindset that there must be main program core error to fix rather than make test less strict!!
2. Test cases should be isolated and clean no left over even on sigterm
3. Test should use bun:test describe,it,afterAll,beforeAll,afterEach,beforeEach without mock
4. test cases should fully verify implementation
5. Test cases should match expected requirements
6. Do not create test of tricks, simulation, stub, mock, etc. you should produce code of real algorithm
7. Do not create any new file for helper,script etc. just do what prompted.
8. test files should only be located outside src at test/unit or test/e2e
9. test should use/modify test/test.util.ts for reusability
