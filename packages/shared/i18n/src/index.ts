// @cockpit/shared-i18n — application-wide translation dictionary + i18next
// instance. Singleton: any package importing this gets the same configured
// instance. Initialized once on first import (sideEffect).
//
// Usage:
//   import i18n from '@cockpit/shared-i18n';
//   i18n.t('chat.welcome');
//   i18n.t('confirm.title', { defaultValue: 'Confirm' });
//
// React: useTranslation() from react-i18next picks up this same global
// instance automatically — no Provider needed for it to work, though the
// app layer wraps with <I18nextProvider> for re-render-on-language-change.

import i18n from 'i18next';
import en from '../locales/en.json';
import zh from '../locales/zh.json';

if (!i18n.isInitialized) {
  i18n.init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    lng: 'en',           // Fixed initial language; client detects in app/I18nProvider
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });
}

export default i18n;
export { i18n };
