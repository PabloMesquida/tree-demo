# Tree Demo

Demo interactiva en Three.js (WebGPU) de un árbol cuyas hojas se desprenden al moverlo con el puntero, caen y vuelven a crecer en las ramas.

## Ejecutar

Necesita Node.js y un navegador con WebGPU (Chrome o Edge recientes).

```bash
npm install
npm run dev
```

Abre la dirección que muestra Vite (por defecto `http://localhost:5173/`).

## Uso

- Pasa el puntero por las ramas para sacudir el árbol; arrastra para girar la cámara.
- El panel permite ajustar la cantidad de hojas, activar o desactivar la caída y la regeneración, reiniciar y sacudir el árbol.
- Añade `#debug` a la URL para ver todos los ajustes y los contadores.

## Tecnología

Three.js 0.186 con `WebGPURenderer` y TSL: la simulación de las hojas se ejecuta en la GPU con compute shaders. Build con Vite.
