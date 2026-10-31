// A button with @carton/react's look (the skin styles `.carton-btn` and its data-variant/data-size) that also takes
// any attribute: the e2e finds controls by `data-testid`, and @carton/react's Button keeps its props narrow.

import { createElement as h, type ButtonHTMLAttributes, type ReactNode } from "react";

export function Btn({ variant = "secondary", size = "sm", className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; children?: ReactNode; "data-testid"?: string }) {
  return h("button", { type: "button", ...rest, className: `carton-btn${className ? ` ${className}` : ""}`, "data-variant": variant, "data-size": size }, h("span", { className: "carton-btn-text" }, children));
}
