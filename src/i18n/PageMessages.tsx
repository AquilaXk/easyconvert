import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { clientMessages, type ClientMessagesPage } from './client-messages';

/** Hands a page's client components the messages that page reads (`PAGE_NAMESPACES`), and nothing more. */
export default async function PageMessages({
  page,
  formatIds,
  children,
}: Readonly<{ page: ClientMessagesPage; formatIds?: readonly string[]; children: ReactNode }>) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={clientMessages(messages, page, formatIds)}>{children}</NextIntlClientProvider>;
}
