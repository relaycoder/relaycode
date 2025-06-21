I will update `src/utils.ts` to add a new parameter.

```diff // src/utils.ts new-unified
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,3 @@
-export function greet(name: string) {
-  return `Hello, ${name}!`;
+export function greet(name: string, enthusiasm: number) {
+  return `Hello, ${name}` + '!'.repeat(enthusiasm);
 }
```

```yaml
projectId: my-project
uuid: 2b8f41e8-31d7-4663-956e-0ebd03f7a1f2
changeSummary:
  - edit: src/utils.ts
```