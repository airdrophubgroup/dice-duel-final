'use client';

import { ReactNode, useEffect } from 'react';
import { MiniKit } from '@worldcoin/minikit-js';

export default function MiniKitProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    try {
      // Video ke mutabiq app ID yahan install hoti hai
      MiniKit.install('app_74bd2499a35b025efb62d99125df7883');
    } catch (error) {
      console.error("MiniKit installation error:", error);
    }
  }, []);

  return <>{children}</>;
}