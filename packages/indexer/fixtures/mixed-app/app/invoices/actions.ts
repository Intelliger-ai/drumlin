"use server";

import { revalidatePath } from "next/cache";

// Positive case for `async.mutation.no-feedback`: mutates and redirects with no
// pending or error surface for the caller.
export async function approveInvoice(formData: FormData) {
  const id = formData.get("id");
  await fetch(`https://api.example.com/invoices/${String(id)}/approve`, {
    method: "POST",
  });
  revalidatePath("/invoices");
}

// Positive case for `flow.destructive.no-confirm`: irreversible, with no
// confirmation step and no undo window.
export async function deleteInvoice(formData: FormData) {
  const id = formData.get("id");
  await fetch(`https://api.example.com/invoices/${String(id)}`, {
    method: "DELETE",
  });
  revalidatePath("/invoices");
}
