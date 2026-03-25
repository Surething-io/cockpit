import i18n from 'i18next';

import en from '@/locales/en.json';
import zh from '@/locales/zh.json';

i18n.init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: 'en', // Fixed initial language; client detects in I18nProvider
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
