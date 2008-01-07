//// $Id$


var RedirectorOverlay = {

    id          : "redirector@einaregilsson.com",
    name        : "Redirector",
    initialized : false,
    strings     : null,

    onLoad : function(event) {
        try {

            // initialization code
            RedirLib.initialize(this);
            RedirLib.debug("Initializing...");
            $('contentAreaContextMenu')
                .addEventListener("popupshowing", function(e) { RedirectorOverlay.showContextMenu(e); }, false);
            
            this.ffversion = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).version;
            
            if (!RedirLib.getBoolPref('showContextMenu')) {
                $('redirector-context').hidden = true;
            }
            if (!RedirLib.getBoolPref('showStatusBarIcon')) {
                $('redirector-status').hidden = true;
            }
            Redirector.init();
            this.overrideOnStateChange();            
            this.overrideOpenNewWindowWith();
            this.overrideOpenNewTabWith();
            this.strings = document.getElementById("redirector-strings");
            Redirector.strings = this.strings;
            this.prefObserver.register();
            this.setStatusBarImg();

            RedirLib.debug("Finished initialization");
            this.initialized = true;

        } catch(e) {
            //Don't use RedirLib because it's initialization might have failed.
            if (this.strings) {
                alert(this.strings.getString("initError")._(this.name) + "\n\n" + e);
            } else {
                alert(e);
            }
        }
    },
    
    isVersion3 : function() {
        return this.ffversion.toString().charAt(0) == '3';
    },

    overrideOnStateChange : function() {
        var origOnStateChange = nsBrowserStatusHandler.prototype.onStateChange;

        nsBrowserStatusHandler.prototype.onStateChange = function(aWebProgress, aRequest, aStateFlags, aStatus) {
            if(aStateFlags & Ci.nsIWebProgressListener.STATE_START
            && aStateFlags| Ci.nsIWebProgressListener.STATE_IS_NETWORK
            && aStateFlags| Ci.nsIWebProgressListener.STATE_IS_REQUEST
                && aRequest && aWebProgress.DOMWindow) {
      
                //If it's not a GET request we'll always do a slow redirect so the web will continue
                //to work in the way you'd expect
                try {
                    var oHttp = aRequest.QueryInterface(Ci.nsIHttpChannel);
                    var method = oHttp.requestMethod;
          
                    if (method != "GET") {
                        origOnStateChange.apply(this, arguments);
                        return;
                    }
        
                } catch(ex) {
                    origOnStateChange.apply(this, arguments);
                    return;
                }

                var uri = aRequest.QueryInterface(Ci.nsIChannel).URI.spec;
                
                RedirLib.debug('Checking url %1 for instant redirect'._(uri));
                var redirectUrl = Redirector.getRedirectUrlForInstantRedirect(uri);
                if (redirectUrl.url && oHttp.notificationCallbacks) {
                    const NS_BINDING_ABORTED = 0x804b0002;
                    aRequest.cancel(NS_BINDING_ABORTED);
                    var newStateFlags = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_NETWORK | Ci.nsIWebProgressListener.STATE_IS_REQUEST;
                    origOnStateChange.call(this, aWebProgress, aRequest, newStateFlags, "");
                    var interfaceRequestor = oHttp.notificationCallbacks.QueryInterface(Ci.nsIInterfaceRequestor);
                    var targetDoc = interfaceRequestor.getInterface(Ci.nsIDOMWindow).document;    
                    var gotoUrl = Redirector.makeAbsoluteUrl(uri, redirectUrl.url);
                    Redirector.goto(gotoUrl, redirectUrl.pattern, uri, targetDoc); 
                } else {
                    origOnStateChange.apply(this, arguments);
                }

            } else {
                origOnStateChange.apply(this, arguments);
            }
            
        };
    },

    overrideOpenNewWindowWith: function() {
      
        window.__openNewWindowWith = window.openNewWindowWith;
        
        
        if (this.isVersion3()) {

            window.openNewWindowWith = function (aUrl, aDocument, aPostData, aAllowThirdPartyFixup, aReferrer) {
                var redirectUrl = Redirector.getRedirectUrlForInstantRedirect(aUrl);
                if (redirectUrl.url) {
                    __openNewWindowWith(redirectUrl.url, aDocument, aPostData, aAllowThirdPartyFixup, aUrl);
                } else {
                    __openNewWindowWith(aUrl, aDocument, aPostData, aAllowThirdPartyFixup, aReferrer);
                }
            };
        
        } else { //version 2.*
        
            window.openNewWindowWith = function (href, sourceURL, postData, allowThirdPartyFixup) {
                var redirectUrl = Redirector.getRedirectUrlForInstantRedirect(href);
                if (redirectUrl.url) {
                    __openNewWindowWith(redirectUrl.url, href, postData, allowThirdPartyFixup);
                } else {
                    __openNewWindowWith(href, sourceURL, postData, allowThirdPartyFixup);
                }
            };
        }
      },


    overrideOpenNewTabWith: function() {
        
        window.__openNewTabWith = window.openNewTabWith;
        if (this.isVersion3()) {
            window.openNewTabWith = function (aUrl, aDocument, aPostData, aEvent, aAllowThirdPartyFixup, aReferrer) {
                var redirectUrl = Redirector.getRedirectUrlForInstantRedirect(aUrl);
                if (redirectUrl.url) {
                    __openNewTabWith(redirectUrl.url, aDocument, aPostData, aEvent, aAllowThirdPartyFixup, aUrl);
                } else {
                    __openNewTabWith(aUrl, aDocument, aPostData, aEvent, aAllowThirdPartyFixup, aReferrer);
                }

            };
        
        } else { //version 2.*
            window.openNewTabWith = function (href, sourceURL, postData, event, allowThirdPartyFixup) {
                var redirectUrl = Redirector.getRedirectUrlForInstantRedirect(href);
                if (redirectUrl.url) {
                    __openNewTabWith(redirectUrl.url, href, postData, event, allowThirdPartyFixup);
                } else {
                    __openNewTabWith(href, sourceURL, postData, event, allowThirdPartyFixup);
                }

            };
        
        }
    },

  
    onDOMContentLoaded : function(event) {
        var redirect, link, links, url;
        
        if (event.target.toString().indexOf('HTMLDocument') == -1) {
            return;
        }

        url = event.target.location.href;

        RedirLib.debug('Processing url %1'._(url));
        Redirector.processUrl(url, event.target);
    },


    onUnload : function(event) {
        RedirectorOverlay.prefObserver.unregister();
        Redirector.prefObserver.unregister();
        //Clean up here
        RedirLib.debug("Finished cleanup");
    },

    showContextMenu : function(event) {
        if (gContextMenu.onLink) {
            $("redirector-context").label = this.strings.getString('addLinkUrl');
        } else {
            $("redirector-context").label = this.strings.getString('addCurrentUrl');
        }
    },

    onContextMenuCommand: function(event) {

        var item = { exampleUrl : window.content.location.href, pattern: window.content.location.href};
        if (gContextMenu.onLink) {
            item.redirectUrl = gContextMenu.link.toString();
        }

        window.openDialog("chrome://redirector/content/redirect.xul",
                    "redirect",
                    "chrome,dialog,modal,centerscreen", item);

        if (item.saved) {
            Redirector.addRedirect(item);
        }

    },

    onMenuItemCommand: function(event) {
        Redirector.openSettings();
    },

    toggleEnabled : function(event) {
        RedirLib.setBoolPref('enabled', !RedirLib.getBoolPref('enabled'));
    },

    statusBarClick : function(event) {
        var LEFT = 0, RIGHT = 2;

        if (event.button == LEFT) {
            RedirectorOverlay.toggleEnabled();
        } else if (event.button == RIGHT) {
            Redirector.openSettings();
            //$('redirector-status-popup').showPopup();
        }
    },

    setStatusBarImg : function() {
        var statusImg = $('redirector-statusbar-img');

        if (RedirLib.getBoolPref('enabled')) {
            statusImg.src = 'chrome://redirector/content/statusactive.PNG'
            statusImg.setAttribute('tooltiptext', this.strings.getString('enabledTooltip'));
            Redirector.enabled = true;
        } else {
            statusImg.src = 'chrome://redirector/content/statusinactive.PNG'
            statusImg.setAttribute('tooltiptext', this.strings.getString('disabledTooltip'));
            Redirector.enabled = false;
        }
    },

    prefObserver : {

        getService : function() {
            return Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranchInternal);
        },

        register: function() {
            this.getService().addObserver('extensions.redirector', this, false);
        },

        unregister: function() {
            this.getService().removeObserver('extensions.redirector', this);
        },

        observe : function(subject, topic, data) {
            if (topic == 'nsPref:changed' && data == 'extensions.redirector.enabled') {
                RedirectorOverlay.setStatusBarImg();
            }
        }

    }


};
window.addEventListener("load", function(event) { RedirectorOverlay.onLoad(event); }, false);
window.addEventListener("DOMContentLoaded", function(event) { RedirectorOverlay.onDOMContentLoaded(event); }, true);
window.addEventListener("unload", function(event) { RedirectorOverlay.onUnload(event); }, false);