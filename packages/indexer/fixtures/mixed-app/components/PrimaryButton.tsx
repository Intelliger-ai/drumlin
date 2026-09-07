// Positive case for `ds.duplicate-primitive`: this reimplements the shadcn
// Button in components/ui/button.tsx rather than using it.
import * as React from "react";

export interface PrimaryButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "destructive" | "outline" | "ghost";
  size?: "default" | "sm" | "lg";
}

export function PrimaryButton({
  variant = "default",
  size = "default",
  ...props
}: PrimaryButtonProps) {
  return <button data-variant={variant} data-size={size} {...props} />;
}
