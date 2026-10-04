# Web

TanStack Start + React + Tailwind CSSの画面です。Python APIを使うため、リポジトリルートの[README](../README.md)の手順でWebとAPIを起動してください。

```sh
# リポジトリルート
python scripts/dev.py
```

`vite.config.ts` の開発・プレビュー用プロキシが `/api` をローカルのPython APIへ転送します。

画面は `src/routes/index.tsx`、APIクライアントと型は `src/lib/assignments.ts`、操作ガイドは `src/routes/about.tsx` にあります。

```sh
# web/ 内
pnpm build
pnpm preview
```

`pnpm build` はWorkers用のビルドとTypeScript型チェックを実行します。プレビューでもPython APIを別途起動してください。
