// Canonical design-system primitive. A local component that reimplements this
// is design-system drift, which `ds.duplicate-primitive` should catch.
import * as React from "react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "destructive" | "outline" | "ghost";
  size?: "default" | "sm" | "lg";
}

export function Button({ variant = "default", size = "default", ...props }: ButtonProps) {
  return <button data-variant={variant} data-size={size} {...props} />;
}
