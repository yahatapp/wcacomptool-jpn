# Web

TanStack Start + React + Tailwind CSSの画面です。CSV処理と役割分担はOR-Tools WASMを使ってブラウザ内で実行し、Python APIは不要です。詳細はリポジトリルートの[README](../README.md)を参照してください。

```sh
# リポジトリルート
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
```

`vite.config.ts`、`src/server.ts`、`public/_headers` がWASMスレッドに必要なCOOP・COEPヘッダーを設定します。

画面は `src/routes/index.tsx`、ブラウザ処理の入り口と型は `src/lib/assignments.ts`、WASMの制約モデルは `src/lib/solver.ts`、操作ガイドは `src/routes/about.tsx` にあります。

```sh
# web/ 内
pnpm build
pnpm preview
```

`pnpm build` はWorkers用のビルドとTypeScript型チェックを実行します。`pnpm test` はWASM・CSV・記録処理、`pnpm test:browser` は実ブラウザで検証します。ブラウザテストの前に `pnpm exec playwright install chromium` を実行してください。
