import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    // A plain <div> first: the App Router focuses a segment's first DOM node, which would pull focus out of the form.
    <div>
      <main id="main-content" tabIndex={-1} className="flex min-h-screen items-center justify-center p-4 outline-none">
        <SignUp />
      </main>
    </div>
  );
}
