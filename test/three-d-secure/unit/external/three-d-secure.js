'use strict';

var Promise = require('../../../../src/lib/promise');
var ThreeDSecure = require('../../../../src/three-d-secure/external/three-d-secure');
var analytics = require('../../../../src/lib/analytics');
var methods = require('../../../../src/lib/methods');
var BraintreeError = require('../../../../src/lib/braintree-error');
var parseUrl = require('url').parse;
var Bus = require('../../../../src/lib/bus');
var deferred = require('../../../../src/lib/deferred');
var VERSION = require('../../../../package.json').version;
var events = require('../../../../src/three-d-secure/shared/events');

function noop() {}

describe('ThreeDSecure', function () {
  beforeEach(function () {
    var self = this;

    this.sandbox.stub(analytics, 'sendEvent');

    this.configuration = {
      gatewayConfiguration: {
        assetsUrl: 'http://example.com/assets'
      }
    };
    this.client = {
      request: this.sandbox.stub().resolves(),
      getConfiguration: function () { return self.configuration; }
    };
  });

  describe('Constructor', function () {
    it('maps provided options to instance property', function () {
      var options = {
        foo: 'bar',
        client: this.client
      };
      var dddS = new ThreeDSecure(options);

      expect(dddS._options).to.equal(options);
    });
  });

  describe('verifyCard', function () {
    beforeEach(function () {
      this.instance = new ThreeDSecure({
        client: this.client
      });

      this.client.request.resolves({
        paymentMethod: {},
        threeDSecureInfo: {}
      });
    });

    it('returns a promise', function () {
      var promise = this.instance.verifyCard({
        nonce: 'fake-nonce',
        amount: 100,
        addFrame: noop,
        removeFrame: noop
      });

      expect(promise).to.be.an.instanceof(Promise);
    });

    it('can be called multiple times if cancelled in between', function () {
      var threeDSecureInfo = {liabilityShiftPossible: true, liabilityShifted: true};
      var self = this;

      this.client.request.resolves({
        paymentMethod: {
          nonce: 'upgraded-nonce',
          threeDSecureInfo: threeDSecureInfo
        },
        threeDSecureInfo: threeDSecureInfo
      });

      return this.instance.verifyCard({
        nonce: 'fake-nonce',
        amount: 100,
        addFrame: noop,
        removeFrame: noop
      }).then(function () {
        return self.instance.cancelVerifyCard();
      }).then(function () {
        return self.instance.verifyCard({
          nonce: 'fake-nonce',
          amount: 100,
          addFrame: noop,
          removeFrame: noop
        });
      }).then(function (data) {
        expect(data.nonce).to.equal('upgraded-nonce');
      });
    });

    it('can be called multiple times if first request failed', function (done) {
      var threeDSecureInfo = {liabilityShiftPossible: true, liabilityShifted: true};

      this.client.request.rejects(new Error('failure'));

      this.instance.verifyCard({
        nonce: 'fake-nonce',
        amount: 100,
        addFrame: noop,
        removeFrame: noop
      }, function () {
        this.client.request.resolves({
          paymentMethod: {
            nonce: 'upgraded-nonce',
            threeDSecureInfo: threeDSecureInfo
          },
          threeDSecureInfo: threeDSecureInfo
        });

        this.instance.verifyCard({
          nonce: 'fake-nonce',
          amount: 100,
          addFrame: noop,
          removeFrame: noop
        }, function (err, data) {
          expect(err).not.to.exist;
          expect(data.nonce).to.equal('upgraded-nonce');

          done();
        });
      }.bind(this));
    });

    it('cannot be called twice without cancelling in between', function (done) {
      var options = {
        nonce: 'fake-nonce',
        amount: 100,
        addFrame: noop,
        removeFrame: noop
      };

      this.client.request.resolves({});

      this.instance.verifyCard(options, noop);

      this.instance.verifyCard(options, function (err, data) {
        expect(data).not.to.exist;

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.eql('MERCHANT');
        expect(err.code).to.eql('THREEDS_AUTHENTICATION_IN_PROGRESS');
        expect(err.message).to.eql('Cannot call verifyCard while existing authentication is in progress.');

        done();
      });
    });

    it('can be called multiple times if authentication completes in between', function (done) {
      var threeDSecure = new ThreeDSecure({
        client: this.client
      });

      var options = {
        nonce: 'abc123',
        amount: 100,
        addFrame: function (err, iframe) {
          expect(err).not.to.exist;
          expect(iframe).to.exist;

          deferred(function () {
            threeDSecure._handleAuthResponse({
              channel: 'some-channel',
              auth_response: '{"paymentMethod":{"type":"CreditCard","nonce":"some-fake-nonce","description":"ending+in+00","consumed":false,"threeDSecureInfo":{"liabilityShifted":true,"liabilityShiftPossible":true,"status":"authenticate_successful","enrolled":"Y"},"details":{"lastTwo":"00","cardType":"Visa"}},"threeDSecureInfo":{"liabilityShifted":true,"liabilityShiftPossible":true},"success":true}' // eslint-disable-line camelcase
            }, options);
          })();
        },
        removeFrame: noop
      };

      this.client.request.resolves({
        paymentMethod: {},
        lookup: {
          acsUrl: 'http://example.com/acs',
          pareq: 'pareq',
          termUrl: 'http://example.com/term',
          md: 'md'
        }
      });

      threeDSecure.verifyCard(options, function (err, data) {
        expect(err).not.to.exist;
        expect(data.nonce).to.equal('some-fake-nonce');
        expect(data.liabilityShifted).to.equal(true);
        expect(data.liabilityShiftPossible).to.equal(true);

        threeDSecure.verifyCard(options, function (err2, data2) {
          expect(err2).not.to.exist;
          expect(data2.nonce).to.equal('some-fake-nonce');
          expect(data2.liabilityShifted).to.equal(true);
          expect(data2.liabilityShiftPossible).to.equal(true);

          done();
        });
      });
    });

    it('requires a nonce', function (done) {
      this.instance.verifyCard({
        amount: 100,
        addFrame: noop,
        removeFrame: noop
      }, function (err, data) {
        expect(data).not.to.exist;

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.eql('MERCHANT');
        expect(err.code).to.eql('THREEDS_MISSING_VERIFY_CARD_OPTION');
        expect(err.message).to.eql('verifyCard options must include a nonce.');

        done();
      });
    });

    it('requires an amount', function (done) {
      this.instance.verifyCard({
        nonce: 'abcdef',
        addFrame: noop,
        removeFrame: noop
      }, function (err, data) {
        expect(data).not.to.exist;

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.eql('MERCHANT');
        expect(err.code).to.eql('THREEDS_MISSING_VERIFY_CARD_OPTION');
        expect(err.message).to.eql('verifyCard options must include an amount.');

        done();
      });
    });

    it('requires addFrame', function (done) {
      this.instance.verifyCard({
        nonce: 'abcdef',
        amount: 100,
        removeFrame: noop
      }, function (err, data) {
        expect(data).not.to.exist;

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.eql('MERCHANT');
        expect(err.code).to.eql('THREEDS_MISSING_VERIFY_CARD_OPTION');
        expect(err.message).to.eql('verifyCard options must include an addFrame function.');

        done();
      });
    });

    it('requires removeFrame', function (done) {
      this.instance.verifyCard({
        nonce: 'abcdef',
        amount: 100,
        addFrame: noop
      }, function (err, data) {
        expect(data).not.to.exist;

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.eql('MERCHANT');
        expect(err.code).to.eql('THREEDS_MISSING_VERIFY_CARD_OPTION');
        expect(err.message).to.eql('verifyCard options must include a removeFrame function.');

        done();
      });
    });

    it('makes a request to the 3DS lookup endpoint without customer data', function (done) {
      var self = this;

      this.client.request.resolves({paymentMethod: {}});

      this.instance.verifyCard({
        nonce: 'abcdef',
        amount: 100,
        addFrame: noop,
        removeFrame: noop
      }, function () {
        expect(self.client.request).to.be.calledOnce;
        expect(self.client.request).to.be.calledWithMatch({
          endpoint: 'payment_methods/abcdef/three_d_secure/lookup',
          method: 'post',
          data: {
            amount: 100
          }
        });

        done();
      });
    });

    it('makes a request to the 3DS lookup endpoint', function (done) {
      var self = this;

      this.client.request.resolves({paymentMethod: {}});

      this.instance.verifyCard({
        nonce: 'abcdef',
        amount: 100,
        customer: {
          mobilePhoneNumber: '8101234567',
          email: 'test@example.com',
          shippingMethod: '01',
          billingAddress: {
            firstName: 'Jill',
            lastName: 'Gal',
            streetAddress: '555 Smith street',
            extendedAddress: '#5',
            locality: 'Oakland',
            region: 'CA',
            postalCode: '12345',
            countryCodeAlpha2: 'US',
            phoneNumber: '1234567'
          }
        },
        addFrame: noop,
        removeFrame: noop
      }, function () {
        expect(self.client.request).to.be.calledOnce;
        expect(self.client.request).to.be.calledWithMatch({
          endpoint: 'payment_methods/abcdef/three_d_secure/lookup',
          method: 'post',
          data: {
            amount: 100,
            customer: {
              mobilePhoneNumber: '8101234567',
              email: 'test@example.com',
              shippingMethod: '01',
              billingAddress: {
                firstName: 'Jill',
                lastName: 'Gal',
                line1: '555 Smith street',
                line2: '#5',
                city: 'Oakland',
                state: 'CA',
                postalCode: '12345',
                countryCode: 'US',
                phoneNumber: '1234567'
              }
            }
          }
        });

        done();
      });
    });

    it('handles errors when hitting the 3DS lookup endpoint', function (done) {
      var error = new Error('network error');

      this.client.request.rejects(error);

      this.instance.verifyCard({
        nonce: 'abcdef',
        amount: 100,
        addFrame: noop,
        removeFrame: noop
      }, function (err) {
        expect(err).to.eql(error);

        done();
      });
    });

    context('when no authentication is required', function () {
      it('retains verification details object for backwards compatibility', function (done) {
        // when porting this code from v2, we accdientally put the 3ds info under verifiaction details
        // instead of at the top level
        var threeDSecureInfo = {liabilityShiftPossible: true, liabilityShifted: true};

        this.client.request.resolves({
          paymentMethod: {nonce: 'upgraded-nonce'},
          threeDSecureInfo: threeDSecureInfo
        });

        this.instance.verifyCard({
          nonce: 'nonce-that-does-not-require-authentication',
          amount: 100,
          addFrame: noop,
          removeFrame: noop
        }, function (err, data) {
          expect(err).not.to.exist;

          expect(data.verificationDetails).to.equal(threeDSecureInfo);
          done();
        });
      });

      it('calls the callback with a nonce and verification details', function (done) {
        var threeDSecureInfo = {liabilityShiftPossible: true, liabilityShifted: true};

        this.client.request.resolves({
          paymentMethod: {nonce: 'upgraded-nonce', details: {cardType: 'Visa'}},
          threeDSecureInfo: threeDSecureInfo
        });

        this.instance.verifyCard({
          nonce: 'nonce-that-does-not-require-authentication',
          amount: 100,
          addFrame: noop,
          removeFrame: noop
        }, function (err, data) {
          expect(err).not.to.exist;
          expect(data.nonce).to.equal('upgraded-nonce');
          expect(data.details).to.deep.equal({cardType: 'Visa'});
          expect(data.liabilityShiftPossible).to.equal(threeDSecureInfo.liabilityShiftPossible);
          expect(data.liabilityShifted).to.equal(threeDSecureInfo.liabilityShifted);

          done();
        });
      });

      it('does not call iframe-related callbacks', function (done) {
        var threeDSecureInfo = {liabilityShiftPossible: true, liabilityShifted: true};
        var addFrame = this.sandbox.spy();
        var removeFrame = this.sandbox.spy();

        this.client.request.resolves({
          paymentMethod: {nonce: 'upgraded-nonce'},
          threeDSecureInfo: threeDSecureInfo
        });

        this.instance.verifyCard({
          nonce: 'nonce-that-does-not-require-authentication',
          amount: 100,
          addFrame: addFrame,
          removeFrame: removeFrame
        }, function () {
          expect(addFrame).to.not.be.called;
          expect(removeFrame).to.not.be.called;

          done();
        });
      });
    });

    context('when authentication is required', function () {
      it('returns an iframe with the right properties if authentication is needed', function (done) {
        var threeDSecure = new ThreeDSecure({
          client: this.client
        });

        this.client.request.resolves({
          paymentMethod: {},
          lookup: {
            acsUrl: 'http://example.com/acs',
            pareq: 'pareq',
            termUrl: 'http://example.com/term',
            md: 'md'
          }
        });

        threeDSecure.verifyCard({
          nonce: 'abc123',
          amount: 100,
          addFrame: function (err, iframe) {
            var url = parseUrl(iframe.src);

            expect(iframe).to.be.an.instanceof(HTMLIFrameElement);
            expect(iframe.width).to.equal('400');
            expect(iframe.height).to.equal('400');
            expect(url.host).to.equal('example.com');

            done();
          },
          removeFrame: noop
        }, function () {
          done(new Error('This should never be called'));
        });
      });

      it('defaults to showing loader on bank frame', function (done) {
        var threeDSecure = new ThreeDSecure({
          client: this.client
        });

        this.client.request.resolves({
          paymentMethod: {},
          lookup: {
            acsUrl: 'http://example.com/acs',
            pareq: 'pareq',
            termUrl: 'http://example.com/term',
            md: 'md'
          }
        });

        threeDSecure.verifyCard({
          nonce: 'abc123',
          amount: 100,
          addFrame: function (err, iframe) {
            var url = parseUrl(iframe.src);

            expect(url.search).to.include('showLoader=true');

            done();
          },
          removeFrame: noop
        }, function () {
          done(new Error('This should never be called'));
        });
      });

      it('can opt out of loader', function (done) {
        var threeDSecure = new ThreeDSecure({
          client: this.client
        });

        this.client.request.resolves({
          paymentMethod: {},
          lookup: {
            acsUrl: 'http://example.com/acs',
            pareq: 'pareq',
            termUrl: 'http://example.com/term',
            md: 'md'
          }
        });

        threeDSecure.verifyCard({
          showLoader: false,
          nonce: 'abc123',
          amount: 100,
          addFrame: function (err, iframe) {
            var url = parseUrl(iframe.src);

            expect(url.search).to.include('showLoader=false');

            done();
          },
          removeFrame: noop
        }, function () {
          done(new Error('This should never be called'));
        });
      });

      it('responds to a CONFIGURATION_REQUEST with the right configuration', function (done) {
        var threeDSecure = new ThreeDSecure({
          client: this.client
        });

        this.client.request.resolves({
          paymentMethod: {},
          lookup: {
            acsUrl: 'http://example.com/acs',
            pareq: 'pareq',
            termUrl: 'http://example.com/term?foo=boo',
            md: 'md'
          }
        });

        threeDSecure.verifyCard({
          nonce: 'abc123',
          amount: 100,
          addFrame: function () {
            var i, configurationRequestHandler;

            for (i = 0; i < Bus.prototype.on.callCount; i++) {
              if (Bus.prototype.on.getCall(i).args[0] === Bus.events.CONFIGURATION_REQUEST) {
                configurationRequestHandler = Bus.prototype.on.getCall(i).args[1];
              }
            }

            configurationRequestHandler(function (data) {
              var authenticationCompleteBaseUrl = threeDSecure._assetsUrl + '/web/' + VERSION + '/html/three-d-secure-authentication-complete-frame.html?channel=';

              expect(data.acsUrl).to.equal('http://example.com/acs');
              expect(data.pareq).to.equal('pareq');
              expect(data.termUrl).to.match(RegExp('^http://example.com/term\\?foo=boo&three_d_secure_version=' + VERSION + '&authentication_complete_base_url=' + encodeURIComponent(authenticationCompleteBaseUrl) + '[a-f0-9-]{36}' + encodeURIComponent('&') + '$'));
              expect(data.parentUrl).to.equal(location.href);

              done();
            });
          },
          removeFrame: noop
        }, function () {
          done(new Error('This should never be called'));
        });
      });

      it('calls removeFrame when receiving an AUTHENTICATION_COMPLETE event', function (done) {
        var threeDSecure = new ThreeDSecure({
          client: this.client
        });
        var removeFrameSpy = this.sandbox.stub();

        this.client.request.resolves({
          paymentMethod: {},
          lookup: {
            acsUrl: 'http://example.com/acs',
            pareq: 'pareq',
            termUrl: 'http://example.com/term',
            md: 'md'
          }
        });

        threeDSecure.verifyCard({
          nonce: 'abc123',
          amount: 100,
          addFrame: function () {
            var authenticationCompleteHandler = Bus.prototype.on.withArgs(events.AUTHENTICATION_COMPLETE).getCall(0).args[1];

            authenticationCompleteHandler({
              auth_response: '{"paymentMethod":{"type":"CreditCard","nonce":"some-fake-nonce","description":"ending+in+00","consumed":false,"threeDSecureInfo":{"liabilityShifted":true,"liabilityShiftPossible":true,"status":"authenticate_successful","enrolled":"Y"},"details":{"lastTwo":"00","cardType":"Visa"}},"threeDSecureInfo":{"liabilityShifted":true,"liabilityShiftPossible":true},"success":true}' // eslint-disable-line camelcase
            });
          },
          removeFrame: removeFrameSpy
        }, function () {
          expect(removeFrameSpy).to.be.calledOnce;

          done();
        });
      });

      it('tears down the bus when receiving an AUTHENTICATION_COMPLETE event', function (done) {
        var threeDSecure = new ThreeDSecure({
          client: this.client
        });

        this.client.request.resolves({
          paymentMethod: {},
          lookup: {
            acsUrl: 'http://example.com/acs',
            pareq: 'pareq',
            termUrl: 'http://example.com/term',
            md: 'md'
          }
        });

        threeDSecure.verifyCard({
          nonce: 'abc123',
          amount: 100,
          addFrame: function () {
            var authenticationCompleteHandler = Bus.prototype.on.withArgs(events.AUTHENTICATION_COMPLETE).getCall(0).args[1];

            authenticationCompleteHandler({
              auth_response: '{"paymentMethod":{"type":"CreditCard","nonce":"some-fake-nonce","description":"ending+in+00","consumed":false,"threeDSecureInfo":{"liabilityShifted":true,"liabilityShiftPossible":true,"status":"authenticate_successful","enrolled":"Y"},"details":{"lastTwo":"00","cardType":"Visa"}},"threeDSecureInfo":{"liabilityShifted":true,"liabilityShiftPossible":true},"success":true}' // eslint-disable-line camelcase
            });
          },
          removeFrame: function () {
            expect(Bus.prototype.teardown).to.be.called;

            done();
          }
        }, noop);
      });

      context('Verify card callback', function () {
        beforeEach(function () {
          this.threeDSecure = new ThreeDSecure({
            client: this.client
          });
          this.authResponse = {
            success: true,
            paymentMethod: {
              nonce: 'auth-success-nonce',
              binData: {
                prepaid: 'No',
                healthcare: 'Unknown',
                debit: 'Unknown',
                durbinRegulated: 'Unknown',
                commercial: 'Unknown',
                payroll: 'Unknown',
                issuingBank: 'Unknown',
                countryOfIssuance: 'CAN',
                productId: 'Unknown'
              },
              details: {
                last2: 11
              },
              description: 'a description',
              threeDSecureInfo: {
                liabilityShiftPossible: true,
                liabilityShifted: true
              }
            },
            threeDSecureInfo: {
              liabilityShiftPossible: true,
              liabilityShifted: true
            }
          };

          this.client.request.resolves({
            paymentMethod: {
              nonce: 'lookup-nonce'
            },
            lookup: {
              acsUrl: 'http://example.com/acs',
              pareq: 'pareq',
              termUrl: 'http://example.com/term',
              md: 'md'
            }
          });

          this.makeAddFrameFunction = function (authResponse) {
            return function () {
              var authenticationCompleteHandler = Bus.prototype.on.withArgs(events.AUTHENTICATION_COMPLETE).getCall(0).args[1];

              authenticationCompleteHandler({
                auth_response: JSON.stringify(authResponse) // eslint-disable-line camelcase
              });
            };
          };
        });

        it('calls the merchant callback when receiving an AUTHENTICATION_COMPLETE event', function (done) {
          this.threeDSecure.verifyCard({
            nonce: 'abc123',
            amount: 100,
            addFrame: this.makeAddFrameFunction(this.authResponse),
            removeFrame: noop
          }, function (err, data) {
            expect(err).not.to.exist;
            expect(data).to.deep.equal({
              nonce: 'auth-success-nonce',
              binData: {
                prepaid: 'No',
                healthcare: 'Unknown',
                debit: 'Unknown',
                durbinRegulated: 'Unknown',
                commercial: 'Unknown',
                payroll: 'Unknown',
                issuingBank: 'Unknown',
                countryOfIssuance: 'CAN',
                productId: 'Unknown'
              },
              details: {
                last2: 11
              },
              description: 'a description',
              liabilityShiftPossible: true,
              liabilityShifted: true
            });

            done();
          });
        });

        it('replaces + with a space in description parameter', function (done) {
          this.authResponse.paymentMethod.description = 'A+description+with+pluses';
          this.threeDSecure.verifyCard({
            nonce: 'abc123',
            amount: 100,
            addFrame: this.makeAddFrameFunction(this.authResponse),
            removeFrame: noop
          }, function (err, data) {
            expect(data.description).to.equal('A description with pluses');

            done();
          });
        });

        it('sends back the new nonce if auth is succesful', function (done) {
          this.threeDSecure.verifyCard({
            nonce: 'abc123',
            amount: 100,
            addFrame: this.makeAddFrameFunction(this.authResponse),
            removeFrame: noop
          }, function (err, data) {
            expect(err).not.to.exist;
            expect(data.nonce).to.equal('auth-success-nonce');
            expect(data.liabilityShiftPossible).to.equal(true);
            expect(data.liabilityShifted).to.equal(true);

            done();
          });
        });

        it('sends back the lookup nonce if auth is not succesful but liability shift is possible', function (done) {
          delete this.authResponse.success;
          this.authResponse.threeDSecureInfo.liabilityShifted = false;

          this.threeDSecure.verifyCard({
            nonce: 'abc123',
            amount: 100,
            addFrame: this.makeAddFrameFunction(this.authResponse),
            removeFrame: noop
          }, function (err, data) {
            expect(err).not.to.exist;
            expect(data.nonce).to.equal('lookup-nonce');
            expect(data.liabilityShiftPossible).to.equal(true);
            expect(data.liabilityShifted).to.equal(false);

            done();
          });
        });

        it('sends back an error if it exists', function (done) {
          delete this.authResponse.success;
          this.authResponse.threeDSecureInfo.liabilityShiftPossible = false;
          this.authResponse.error = {
            message: 'an error'
          };

          this.threeDSecure.verifyCard({
            nonce: 'abc123',
            amount: 100,
            addFrame: this.makeAddFrameFunction(this.authResponse),
            removeFrame: noop
          }, function (err, data) {
            expect(data).not.to.exist;

            expect(err).to.be.an.instanceof(BraintreeError);
            expect(err.type).to.eql(BraintreeError.types.UNKNOWN);
            expect(err.message).to.eql('an error');

            done();
          });
        });
      });
    });
  });

  describe('cancelVerifyCard', function () {
    beforeEach(function () {
      this.threeDS = new ThreeDSecure({client: this.client});
      this.threeDS._verifyCardInProgress = true;
      this.threeDS._lookupPaymentMethod = {
        threeDSecureInfo: {
          liabilityShiftPossible: true,
          liabilityShifted: true
        }
      };
    });

    it('returns a promise', function () {
      var promise = this.threeDS.cancelVerifyCard();

      expect(promise).to.be.an.instanceof(Promise);
    });

    it('sets _verifyCardInProgress to false', function (done) {
      this.threeDS._verifyCardInProgress = true;

      this.threeDS.cancelVerifyCard(function () {
        expect(this.threeDS._verifyCardInProgress).to.equal(false);

        done();
      }.bind(this));
    });

    it('passes back an error if there is no _lookupPaymentMethod', function (done) {
      delete this.threeDS._lookupPaymentMethod;

      this.threeDS.cancelVerifyCard(function (err) {
        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal(BraintreeError.types.MERCHANT);
        expect(err.code).to.eql('THREEDS_NO_VERIFICATION_PAYLOAD');
        expect(err.message).to.equal('No verification payload available.');

        done();
      });
    });

    it('passes back the result of the initial lookup', function (done) {
      this.threeDS._lookupPaymentMethod = {
        nonce: 'fake-nonce',
        threeDSecureInfo: {
          liabilityShiftPossible: true,
          liabilityShifted: false
        }
      };

      this.threeDS.cancelVerifyCard(function (err, response) {
        expect(response.nonce).to.eql('fake-nonce');
        expect(response.liabilityShiftPossible).to.eql(true);
        expect(response.liabilityShifted).to.eql(false);

        done();
      });
    });
  });

  describe('teardown', function () {
    beforeEach(function () {
      this.threeDS = new ThreeDSecure({client: this.client});
    });

    it('calls teardown analytic', function (done) {
      var threeDS = this.threeDS;

      threeDS.teardown(function () {
        expect(analytics.sendEvent).to.be.calledWith(threeDS._options.client, 'threedsecure.teardown-completed');
        done();
      });
    });

    it('returns a promise', function () {
      var promise = this.threeDS.teardown();

      expect(promise).to.be.an.instanceof(Promise);
    });

    it('replaces all methods so error is thrown when methods are invoked', function (done) {
      var threeDS = this.threeDS;

      threeDS.teardown(function () {
        methods(ThreeDSecure.prototype).forEach(function (method) {
          var error;

          try {
            threeDS[method]();
          } catch (err) {
            error = err;
          }

          expect(error).to.be.an.instanceof(BraintreeError);
          expect(error.type).to.equal(BraintreeError.types.MERCHANT);
          expect(error.code).to.equal('METHOD_CALLED_AFTER_TEARDOWN');
          expect(error.message).to.equal(method + ' cannot be called after teardown.');

          done();
        });
      });
    });

    it('does not attempt to tear down bus if it does not exist', function (done) {
      this.threeDS.teardown(function () {
        expect(Bus.prototype.teardown).to.not.be.called;

        done();
      });
    });

    it('tears down bus if it exists', function (done) {
      var threeDS = this.threeDS;

      threeDS._bus = new Bus({
        channel: 'foo',
        merchantUrl: 'bar'
      });

      threeDS.teardown(function () {
        expect(threeDS._bus.teardown).to.be.calledOnce;

        done();
      });
    });

    it('does not attempt to remove iframe from DOM if there is no iframe on instance', function (done) {
      this.sandbox.spy(document.body, 'removeChild');

      this.threeDS.teardown(function () {
        expect(document.body.removeChild).to.not.be.called;

        done();
      });
    });

    it('does not remove iframe from DOM if it is not in the DOM', function (done) {
      var iframe = document.createElement('iframe');

      this.threeDS._bankIframe = iframe;
      this.sandbox.spy(document.body, 'removeChild');

      this.threeDS.teardown(function () {
        expect(document.body.removeChild).to.not.be.called;

        done();
      });
    });

    it('removes bank iframe', function (done) {
      var iframe = document.createElement('iframe');

      this.sandbox.spy(document.body, 'removeChild');

      document.body.appendChild(iframe);

      this.threeDS._bankIframe = iframe;

      this.threeDS.teardown(function () {
        expect(document.body.contains(iframe)).to.equal(false);
        expect(document.body.removeChild).to.be.calledOnce;
        expect(document.body.removeChild).to.be.calledWith(iframe);

        done();
      });
    });
  });
});
