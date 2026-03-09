import "./globals.css";

export const metadata = {
  title: "DJ Admin Standalone",
  description: "Standalone internal admin for inquiry, workspace, contract, and invoice workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
