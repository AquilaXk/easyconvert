// The root layout of the app is src/app/[locale]/layout.tsx. This one exists because src/app/not-found.tsx, which answers a
// request no locale was resolved for, needs a layout above it.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
