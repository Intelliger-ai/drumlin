import * as React from "react";

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}

export function SelectItem(props: React.OptionHTMLAttributes<HTMLOptionElement>) {
  return <option {...props} />;
}
