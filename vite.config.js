// PORT lets a launcher pick a free port; `npm run dev` alone uses 5173 (or the next free one).
const port = Number(process.env.PORT) || 5173

export default {
    server: { host: 'localhost', port, strictPort: Boolean(process.env.PORT) },
    build: { target: 'esnext', sourcemap: true }
}
