// `react` for carton-ui.js: the editor's own React, which the History panel hands over (window.__cartonReact) before
// it imports carton-ui.js (scripts/carton/editor-panel.js). @carton/react only uses createElement, the hooks and
// memo, so these are what it gets.
const R = window.__cartonReact;
export default R;
export const { createElement, Fragment, memo, forwardRef, createContext, useContext, useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useId, useReducer, useSyncExternalStore, useTransition, useDeferredValue, startTransition, Children, isValidElement, cloneElement } = R;
