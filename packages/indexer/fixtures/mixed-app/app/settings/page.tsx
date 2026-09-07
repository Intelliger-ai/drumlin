import { PrimaryButton } from "../../components/PrimaryButton";

// Positive case for `flow.dead-end`: reachable from the layout nav, but offers
// no way onward and is not a terminal success state.
export default function SettingsPage() {
  return (
    <main>
      <h1>Settings</h1>
      <PrimaryButton>Save</PrimaryButton>
    </main>
  );
}
