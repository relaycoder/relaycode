I'm performing a few operations.

First, editing `main.ts`.
```typescript // src/main.ts
// START
console.log("Updated main");
// END
```

Second, deleting `utils.ts`.
```typescript // src/utils.ts
//TODO: delete this file
```

Finally, adding a new component.
```typescript // "src/components/New Component.tsx" new-unified
--- a/src/components/New Component.tsx
+++ b/src/components/New Component.tsx
@@ -0,0 +1,3 @@
+export const NewComponent = () => {
+  return <div>New!</div>;
+};
```

```yaml
projectId: my-project
uuid: 5e1a41d8-64a7-4663-c56e-3ebd03f7a1f5
changeSummary:
  - edit: src/main.ts
  - delete: src/utils.ts
  - new: src/components/New Component.tsx
```