import type { Metadata } from 'next';
import './style.css';
export const metadata: Metadata = { title: 'FairLaunch Studio', description: 'Create and trade tokens on GIWA Sepolia with Ammora' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
