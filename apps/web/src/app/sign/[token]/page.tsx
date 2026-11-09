import type { Metadata } from "next";
import { SignLoader } from "@/components/SignLoader";

// The public signing page. No login, no app shell, no search indexing (the headers are in
// next.config.mjs). It holds no data itself: the document and its checks come from /api/sign/[token],
// which rate-limits, and which answers every bad link with the same 404.

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agreement", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }> };

const SignPage = async ({ params }: Props) => <SignLoader token={(await params).token} />;

export default SignPage;
