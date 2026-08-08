// thinking-orbs' bundle imports react at top level, but we only call its pure canvas painters
// (MODE_DRAWS / resolvePreset) — vite.config aliases react + react/jsx-runtime here so the
// React component exports resolve without pulling React into a vanilla demo.
export const useState = () => { throw new Error('react stub'); };
export const useEffect = () => { throw new Error('react stub'); };
export const useRef = () => { throw new Error('react stub'); };
export const jsx = () => { throw new Error('react stub'); };
export const jsxs = jsx;
export const Fragment = null;
