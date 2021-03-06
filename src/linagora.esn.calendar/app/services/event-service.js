const _ = require('lodash');
require('../constants.js');
require('../services/ical.js');
require('../services/cached-event-source.js');
require('../services/calendar-api.js');
require('../services/calendar-event-emitter.js');
require('../services/shells/calendar-shell.js');
require('../services/calendar-utils.js');
require('../services/event-api.js');
require('../services/event-utils.js');
require('../services/path-builder.js');
require('../services/master-event-cache.js');
require('../freebusy/event-freebusy-hooks.service.js');

(function(angular) {
  'use strict';

  angular.module('esn.calendar')
         .service('calEventService', calEventService);

  function calEventService(
    $q,
    $http,
    $rootScope,
    ICAL,
    calCachedEventSource,
    calendarAPI,
    calendarEventEmitter,
    CalendarShell,
    calendarUtils,
    calEventAPI,
    calEventUtils,
    calPathBuilder,
    gracePeriodService,
    calMasterEventCache,
    calFreebusyHooksService,
    notificationFactory,
    esnI18nService,
    CAL_GRACE_DELAY,
    CAL_GRACE_DELAY_IS_ACTIVE,
    CAL_EVENTS,
    session) {

      var self = this;
      var oldEventStore = {};

      self.changeParticipation = changeParticipation;
      self.sendCounter = sendCounter;
      self.getInvitedAttendees = getInvitedAttendees;
      self.getEvent = getEvent;
      self.listEvents = listEvents;
      self.createEvent = createEvent;
      self.modifyEvent = modifyEvent;
      self.checkAndUpdateEvent = checkAndUpdateEvent;
      self.removeEvent = removeEvent;
      self.searchEvents = searchEvents;
      self.getEventByUID = getEventByUID;
      self.getEventFromICSUrl = getEventFromICSUrl;
      self.onEventCreatedOrUpdated = onEventCreatedOrUpdated;

      ////////////

      /**
       * Get the event from backend and push it in several caches.
       *
       * @param {String} calendarId
       * @param {String} eventUID
       */
      function onEventCreatedOrUpdated(calendarHomeId, calendarId, eventUID) {
        return getEvent(calPathBuilder.forEventId(calendarHomeId, calendarId, eventUID)).then(function(event) {
          calCachedEventSource.registerUpdate(event);
          calMasterEventCache.save(event);
          calendarEventEmitter.emitModifiedEvent(event);

          return event;
        });
      }

      /**
       * List all events between a specific range [start..end] in a calendar defined by its path.<
       * @param  {String}   calendarPath the calendar path. it should be something like /calendars/<homeId>/<id>.json
       * @param  {calMoment} start        start date
       * @param  {calMoment} end          end date (inclusive)
       * @param  {String}   timezone     the timezone in which we want the returned events to be in
       * @return {[CalendarShell]}       an array of CalendarShell or an empty array if no events have been found
       */
      function listEvents(calendarPath, start, end, timezone) {
        return calendarAPI.listEvents(calendarPath, start, end, timezone)
          .then(function(events) {
            return events.reduce(function(shells, icaldata) {
              var vcalendar = new ICAL.Component(icaldata.data);
              var vevents = vcalendar.getAllSubcomponents('vevent');

              vevents.forEach(function(vevent) {
                var shell = new CalendarShell(vevent, {path: icaldata._links.self.href, etag: icaldata.etag});

                shells.push(shell);
              });

              return shells;
            }, []);
          })
          .catch($q.reject);
      }

      /**
       * Search all events depending on the advanced search options.
       * @method searchEvents
       * @param {Object} options the search options
       * @param {CalendarCollectionShell[]} options.calendars the list of CalendarCollectionShell to search in
       * @param {number} options.offset the starting position to search from
       * @param {number} options.limit the maximum number of events to be returned
       * @param {Object} options.query the search query options
       * @param {Object} options.sortKey the key to sort the result
       * @param {Object} options.sortOrder the order to sort the result by the key
       * @param {Object} options.query.advanced the advanced search options
       * @param {string} options.query.advanced.contains the string to be found in the events' properties
       * @param {Array} [options.query.advanced.organizers] the array of organizers to search with
       * @param {Array} [options.query.advanced.attendees] the array of attendees to search with
       * @return {[CalendarShell]} an array of CalendarShell or an empty array if no events have been found
       */
      function searchEvents(options) {
        if (!Array.isArray(options.calendars) || !options.calendars.length) {
          return $q.resolve([]);
        }

        return calendarAPI.searchEvents(options).then(function(events) {
          return events.map(function(event) { return event.data; });
        });
      }

      /**
       * Get all invitedAttendees in a vcalendar object.
       * @param  {ICAL.Component}      vcalendar The ICAL.component object
       * @param  {[String]}            emails    The array of emails against which we will filter vcalendar attendees
       * @return {[Object]}                        An array of attendees
       */
      function getInvitedAttendees(vcalendar, emails) {
        var vevent = vcalendar.getFirstSubcomponent('vevent');
        var attendees = vevent.getAllProperties('attendee');
        var organizer = vevent.getFirstProperty('organizer');
        var organizerId = organizer && organizer.getFirstValue().toLowerCase();

        var emailMap = Object.create(null);

        emails.forEach(function(email) { emailMap[calendarUtils.prependMailto(email.toLowerCase())] = true; });

        var invitedAttendees = [];

        for (var i = 0; i < attendees.length; i++) {
          if (attendees[i].getFirstValue().toLowerCase() in emailMap) {
            invitedAttendees.push(attendees[i]);
          }
        }

        // We also need the organizer to work around an issue in Lightning
        if (organizer && organizerId in emailMap) {
          invitedAttendees.push(organizer);
        }

        return invitedAttendees;
      }

      /**
       * Get an event from its path
       * @param  {String} eventPath        the path of the event to get
       * @return {CalendarShell}           the found event wrap into a CalendarShell
       */
      function getEvent(eventPath) {
        return calEventAPI.get(eventPath)
          .then(function(response) {
            return CalendarShell.from(response.data, {path: eventPath, etag: response.headers('ETag')});
          });
      }

    /**
     * Gets an event by its UID. This searches in all user's calendar.
     *
     * @param calendarHomeId {String} The calendar home ID to search in
     * @param {String} uid The event UID to search for.
     *
     * @return {CalendarShell} A {@link CalendarShell} object representing the found event
     */
      function getEventByUID(calendarHomeId, uid) {
        return calendarAPI.getEventByUID(calendarHomeId, uid)
          .then(_.head) // There's only one item returned
          .then(function(item) {
            return CalendarShell.from(item.data, { path: item._links.self.href, etag: item.etag });
          });
      }

      /**
       * Create a new event in the calendar defined by its path. If options.graceperiod is true, the request will be handled by the grace
       * period service.
       * @param  {Object}             calendar     the calendar to create the event in
       * @param  {CalendarShell}      event        the event to PUT to the caldav server
       * @param  {Object}             options      options needed for the creation. The structure is {graceperiod: Boolean}
       * @return {Mixed}                           true if success, false if cancelled, the http response if no graceperiod is used.
       */
      function createEvent(calendar, event, options) {
        function buildICSPath(path) {
          return path.replace(/\/$/, '') + '/' + event.uid + '.ics';
        }

        var taskId = null;
        var eventPath;

        if (calendar.isSubscription()) {
          eventPath = buildICSPath(calPathBuilder.forCalendarPath(calendar.source.calendarHomeId, calendar.source.id));
        } else {
          eventPath = buildICSPath(calPathBuilder.forCalendarPath(calendar.calendarHomeId, calendar.id));
        }

        event.path = eventPath;

        function onTaskCancel() {
          calCachedEventSource.deleteRegistration(event);
          calendarEventEmitter.emitRemovedEvent(event.uid);
          event.isRecurring() && calMasterEventCache.remove(event);

          return false;
        }

        return calEventAPI.create(eventPath, event.vcalendar, options)
          .then(function(response) {
            if (!CAL_GRACE_DELAY_IS_ACTIVE || typeof response !== 'string') {
              return response;
            }

            event.gracePeriodTaskId = taskId = response;
            event.isRecurring() && calMasterEventCache.save(event);
            calCachedEventSource.registerAdd(event);
            calendarEventEmitter.emitCreatedEvent();

            return gracePeriodService.grace({
              id: taskId,
              delay: CAL_GRACE_DELAY,
              context: {id: event.uid},
              performedAction: esnI18nService.translate('You are about to create a new event (%s).', calEventUtils.getEventTitle(event)),
              cancelFailed: 'An error has occured, the creation could not been reverted',
              cancelTooLate: 'It is too late to cancel the creation',
              gracePeriodFail: 'Event creation failed. Please refresh your calendar',
              successText: 'Event created'
            }).then(_.constant(true), onTaskCancel);
          }, function(err) {
            notificationFactory.weakError('Event creation failed', esnI18nService.translate('%s. Please refresh your calendar', err.statusText || err));

            return $q.reject(err);
          })
          .then(function(response) {
            !CAL_GRACE_DELAY_IS_ACTIVE && notificationFactory.weakSuccess('createEvent', esnI18nService.translate('Event created'));

            return response;
          })
          .finally(function() {
            event.gracePeriodTaskId = undefined;
          });
      }

      /**
       * Remove an event in the calendar defined by its path.
       * @param  {String}        eventPath            The event path. it should be something like /calendars/<homeId>/<id>/<eventId>.ics
       * @param  {CalendarShell} event                The event from fullcalendar. It is used in case of rollback.
       * @param  {String}        etag                 The etag
       * @param  {String}        removeAllInstance    Make sens only for instance of recurring event. If true all the instance of the recurring event will be removed
       * @return {Boolean}                 true on success, false if cancelled
       */
      function removeEvent(eventPath, event, etag, removeAllInstance) {
        if (!etag && !event.isInstance()) {
          // This is a noop and the event is not created yet in sabre/dav,
          // we then should only remove the event from fullcalendar
          // and cancel the taskid corresponding on the event.
          notificationFactory.weakInfo('Calendar', esnI18nService.translate('%s has been deleted.', calEventUtils.getEventTitle(event)));

          return gracePeriodService.cancel(event.gracePeriodTaskId).then(function() {
            calCachedEventSource.deleteRegistration(event);
            calendarEventEmitter.emitRemovedEvent(event.id);

            return true;
          }, $q.reject);
        } else if (event.gracePeriodTaskId) {
          gracePeriodService.cancel(event.gracePeriodTaskId);
        }

        var taskId = null;

        function onTaskCancel() {
          calCachedEventSource.deleteRegistration(event);
          calendarEventEmitter.emitCreatedEvent(event);
        }

        function performRemove() {
          return calEventAPI.remove(eventPath, etag)
            .then(function(id) {
              if (!CAL_GRACE_DELAY_IS_ACTIVE) {
                return id;
              }

              event.gracePeriodTaskId = taskId = id;
              calCachedEventSource.registerDelete(event);
              calendarEventEmitter.emitRemovedEvent(event.id);

              return gracePeriodService.grace({
                id: taskId,
                delay: CAL_GRACE_DELAY,
                context: {id: event.uid},
                performedAction: esnI18nService.translate('You are about to delete the event (%s).', calEventUtils.getEventTitle(event)),
                cancelFailed: 'An error has occurred, can not revert the deletion',
                cancelSuccess: esnI18nService.translate('Calendar - Deletion of %s has been cancelled', calEventUtils.getEventTitle(event)),
                cancelTooLate: 'It is too late to cancel the deletion',
                successText: 'Event removed',
                gracePeriodFail: {
                  text: 'Event deletion failed. Please refresh your calendar',
                  delay: -1,
                  hideCross: true,
                  actionText: 'Refresh calendar',
                  action: function() {
                    calCachedEventSource.resetCache();
                    $rootScope.$broadcast(CAL_EVENTS.CALENDAR_REFRESH);
                  }
                 }

              }).then(_.constant(true), function() {
                onTaskCancel();

                return false;
              });
            }, function(err) {
              notificationFactory.weakError(esnI18nService.translate('Event deletion failed', '%s. Please refresh your calendar', err.statusText || err));

              return $q.reject(err);
            })
            .then(function(response) {
              !CAL_GRACE_DELAY_IS_ACTIVE && notificationFactory.weakSuccess('performRemove', esnI18nService.translate('Event removed'));

              return CAL_GRACE_DELAY_IS_ACTIVE ? response : true;
            })
            .finally(function() {
              event.gracePeriodTaskId = undefined;
            });
        }

        if (event.isInstance()) {
          return event.getModifiedMaster()
            .then(function(oldMaster) {
              var newMaster = oldMaster.clone();

              if (removeAllInstance || oldMaster.expand(null, null, 2).length < 2) {
                return performRemove();
              }

              newMaster.deleteInstance(event);

              //we use self.modifyEvent and not modifyEvent for ease of testing
              //this is also the reason why this is a service and not a factory so we can mock modifyEvent
              return self.modifyEvent(eventPath, newMaster, oldMaster, etag);
            });
        }

        return performRemove();
      }

      /**
       * Check all the conditions and call the update function if preconditions are OK
       * @param {CalendarShell} event     The event to check
       * @param {Function}      updateFn  The update function to call
       * @param {Function}      editFn    The edit function to call if user wants to go back to edition mode
       * @param {Function}      cancelFn  The cancel function to call if the user wants to cancel the update
       */
      function checkAndUpdateEvent(event, updateFn, editFn, cancelFn) {
        calFreebusyHooksService.onUpdate(event, updateFn, editFn, cancelFn);
      }

      /**
       * Modify an event in the calendar defined by its path.
       * @param  {String}            path              the event path. it should be something like /calendars/<homeId>/<id>/<eventId>.ics
       * @param  {CalendarShell}     event             the new event.
       * @param  {CalendarShell}     oldEvent          the old event from fullcalendar. It is used in case of rollback and hasSignificantChange computation.
       * @param  {String}            etag              the etag
       * @param  {Function}          onCancel          callback called in case of rollback, ie when we cancel the task
       * @param  {Object}            options           options needed for the creation. The structure is
       *   {graceperiod: Boolean, notifyFullcalendar: Boolean, graceperiodMessage: Object}
       *                                               graceperiodMessage allow to override message displayed during the graceperiod
       * @return {Boolean}                             true on success, false if cancelled
       */
      function modifyEvent(path, event, oldEvent, etag, onCancel, options) {
        oldEvent = oldEventStore[event.uid] = oldEventStore[event.uid] || oldEvent;
        options = options || {};

        if (calEventUtils.hasSignificantChange(event, oldEvent)) {
          event.changeParticipation('NEEDS-ACTION');
          // see https://github.com/fruux/sabre-vobject/blob/0ae191a75a53ad3fa06e2ea98581ba46f1f18d73/lib/ITip/Broker.php#L69
          // see RFC 5546 https://tools.ietf.org/html/rfc5546#page-11
          // The calendar client is in charge to handle the SEQUENCE incrementation
          event.sequence = event.sequence + 1;
        }

        if (event.gracePeriodTaskId) {
          gracePeriodService.cancel(event.gracePeriodTaskId);
        }

        var taskId = null;

        function onTaskCancel() {
          delete oldEventStore[event.uid];
          onCancel && onCancel(); //order matter, onCancel should be called before emitModifiedEvent because it can mute oldEvent
          calCachedEventSource.registerUpdate(oldEvent);
          oldEvent.isRecurring() && calMasterEventCache.save(oldEvent);
          calendarEventEmitter.emitModifiedEvent(oldEvent);
        }

        return event.getModifiedMaster().then(function(masterEvent) {
          return calEventAPI.modify(path, masterEvent.vcalendar, etag);
        })
          .then(function(id) {
            if (!CAL_GRACE_DELAY_IS_ACTIVE) {
              return id;
            }

            event.gracePeriodTaskId = taskId = id;
            calCachedEventSource.registerUpdate(event);
            event.isRecurring() && calMasterEventCache.save(event);
            calendarEventEmitter.emitModifiedEvent(event);

            return gracePeriodService.grace(angular.extend({
              id: taskId,
              delay: CAL_GRACE_DELAY,
              context: {id: event.uid},
              performedAction: esnI18nService.translate('You are about to modify an event (%s).', calEventUtils.getEventTitle(event)),
              cancelFailed: 'An error has occured, the modification can not be reverted',
              cancelTooLate: 'It is too late to cancel the modification',
              cancelSuccess: esnI18nService.translate('Calendar - Modification of %s has been canceled.', calEventUtils.getEventTitle(event)),
              gracePeriodFail: {
                text: 'Event modification failed, please refresh your calendar',
                delay: -1,
                hideCross: true,
                actionText: 'Refresh calendar',
                action: function() {
                  calCachedEventSource.resetCache();
                  $rootScope.$broadcast(CAL_EVENTS.CALENDAR_REFRESH);
                }
               },
              successText: 'Event updated'
            }, options.graceperiodMessage)).then(_.constant(true), function() {
              onTaskCancel();

              return false;
            });
          }, function(err) {
            notificationFactory.weakError('Event modification failed', esnI18nService.translate('%s, Please refresh your calendar', err.statusText || err));

            return $q.reject(err);
          })
          .then(function(response) {
            !CAL_GRACE_DELAY_IS_ACTIVE && notificationFactory.weakSuccess('modifyEvent', esnI18nService.translate('Event updated'));

            return CAL_GRACE_DELAY_IS_ACTIVE ? response : true;
          })
          .finally(function() {
            delete oldEventStore[event.uid];
            event.gracePeriodTaskId = undefined;
          });
      }

      /**
       * Change the status of participation of all or part of attendees (emails) of an event
       * @param  {String}                   eventPath       the event path. it should be something like /calendars/<homeId>/<id>/<eventId>.ics
       * @param  {CalendarShell}            event      the event in which we seek the attendees
       * @param  {[String]}                 emails     an array of emails to change the participation status for
       * @param  {String}                   status     the status in which attendees status will be set
       * @param  {String}                   etag       the etag
       * @param  {Boolean}                  emitEvents true if you want to emit the event to the fullcalendar false if not
       * @return {Mixed}                               the event as CalendarShell in case of 200 or 204, the response otherwise
       * Note that we retry the request in case of 412. This is the code returned for a conflict.
       */
      function changeParticipation(eventPath, event, emails, status, etag, emitEvents) {

        emitEvents = emitEvents || true;
        if (!angular.isArray(event.attendees)) {
          return $q.when(null);
        }
        if (!event.changeParticipation(status, emails)) {
          return $q.when(null);
        }

        return $q.when(event.getModifiedMaster()).then(function(masterEvent) {

          return calEventAPI.changeParticipation(eventPath, masterEvent.vcalendar, etag)
            .then(function(response) {
              if (response.status === 200) {
                return CalendarShell.from(response.data, {path: eventPath, etag: response.headers('ETag')});
              } else if (response.status === 204) {
                return getEvent(eventPath).then(function(shell) {
                  if (emitEvents) {
                    calendarEventEmitter.emitModifiedEvent(shell);
                  }

                  return shell;
                });
              }

              return $q.reject('changeParticipation unhandle server status code : ' + response.status);
            });
        }).catch(function(response) {
          if (response.status === 412) {
            return self.getEvent(eventPath).then(function(shell) {
              // A conflict occurred. We've requested the event data in the
              // response, so we can retry the request with this data.
              return changeParticipation(eventPath, shell, emails, status, shell.etag);
            });
          }

          return $q.reject(response);
        });
      }

      /**
       * Answers to an invite with a counter proposal (suggesting another time)
       * @param  {CalendarShell}            suggestedEvent      the event in which we seek the attendees
       * See https://tools.ietf.org/html/rfc5546#page-86
       */
      function sendCounter(suggestedEvent) {
        if (!suggestedEvent || !suggestedEvent.vcalendar) {
          return $q.when();
        }

        var requestBody = _generateCounterRequestBody(suggestedEvent, session.user.preferredEmail);

        return calEventAPI.sendCounter(suggestedEvent.path, requestBody);
      }

      function _generateCounterRequestBody(sourceEvent, senderEmail) {
        var counterEvent = sourceEvent.clone(),
            vcalendar = counterEvent.vcalendar;

        if (vcalendar.hasProperty('method')) {
          vcalendar.updatePropertyWithValue('method', 'COUNTER');
        } else {
          vcalendar.addPropertyWithValue('method', 'COUNTER');
        }

        return {
          ical: vcalendar.toString(),
          sender: senderEmail,
          recipient: counterEvent.organizer.email,
          uid: counterEvent.uid,
          sequence: counterEvent.sequence,
          method: vcalendar.getFirstPropertyValue('method')
        };
      }

      function getEventFromICSUrl(url) {
        return $http.get(url).then(function(response) {
          return new CalendarShell(ICAL.Component.fromString(response.data));
        });
      }
  }
})(angular);
