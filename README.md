# Tree Demo

Interactive Three.js (WebGPU) demo of a tree whose leaves come loose when you shake it with the pointer, fall, and grow back on the branches.

## Run

Requires Node.js and a browser with WebGPU support (recent Chrome or Edge).

```bash
npm install
npm run dev
```

Open the address Vite prints (by default `http://localhost:5173/`).

## Usage

- Move the pointer over the branches to shake the tree; drag to orbit the camera.
- The panel lets you set the number of leaves, turn falling and regrowth on or off, reset, and shake the whole tree.
- Add `#debug` to the URL to show every setting and the particle counters.

## Tech

Three.js 0.186 with `WebGPURenderer` and TSL: the leaf simulation runs on the GPU in compute shaders. Built with Vite.
