import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { clientMessages, type ClientMessagesPage } from './client-messages';
import ViewerTimeZone from './ViewerTimeZone';

/** Hands a page's client components the messages that page reads (`PAGE_NAMESPACES`), and the viewer's time zone. */
export default async function PageMessages({
  page,
  formatIds,
  children,
}: Readonly<{ page: ClientMessagesPage; formatIds?: readonly string[]; children: ReactNode }>) {
  const messages = await getMessages();
  return (
    <NextIntlClientProvider messages={clientMessages(messages, page, formatIds)}>
      <ViewerTimeZone>{children}</ViewerTimeZone>
    </NextIntlClientProvider>
  );
}
