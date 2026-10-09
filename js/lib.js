// Single import point for the vendored UI library (Preact + hooks + htm).
// No build step: everything is plain ES modules served as-is.
import { h, render, Component, Fragment, createContext, createRef } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';
export { h, render, Component, Fragment, createContext, createRef };
export {
  useState, useReducer, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext,
} from '../vendor/hooks.module.js';
export const html = htm.bind(h);
