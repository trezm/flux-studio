define([
    'jquery',
    'helpers/i18n',
    'helpers/local-storage'

], function($, i18n, localStorage) {
    'use strict';

    return function(args) {
        $('body').on('change', '#select-lang', function(e) {
            args.state.lang = i18n.setActiveLang(e.currentTarget.value).get();
        });

        (function() {
            var $body = $('body'),
                is_ready = localStorage.get('printer-is-ready') || '';

            is_ready = ('' === is_ready ? false : 'true' === is_ready);

            if (true === is_ready) {
                $body.addClass('is-ready');
            }
            else {
                $body.removeClass('is-ready');
            }
        })();
    };
});