angular.module('esnApp')
  // don't remove $state from here or ui-router won't route...
  .run(function (session, ioConnectionManager, $state) { // eslint-disable-line
    session.ready.then(function () {
      ioConnectionManager.connect();
    });
  })
  .run(function settingLanguage($cookies, $translate, esnConfig, ESN_I18N_DEFAULT_LOCALE) {
    esnConfig('core.language')
      .then(function(language) {
        $cookies.locale = language;
        $translate.use(language);
      })
      .catch(function() {
        $cookies.locale = ESN_I18N_DEFAULT_LOCALE;
      });
  })
  .run(function(editableOptions) {
    editableOptions.theme = 'bs3';
  });
