/*
 * dotmap.js - the map pane, a thin layer over Leaflet.
 *
 * It owns no document state: it renders whatever list of dots it is handed and
 * reports interactions back through callbacks, which app.js turns into text
 * edits. The text is always the source of truth, the map is a view of it.
 */
(function (global) {
  'use strict';

  var humandot = global.DOTE.humandot;
  var TAG = humandot.TAG;

  var DEFAULT_CENTER = [44.8125, 20.4612];  // Beograd, latitude/longitude for Leaflet
  var DEFAULT_ZOOM = 12;

  // marker flavour follows the most specific label the dot carries
  function markerKind(dot) {
    if (!dot.valid) return 'invalid';
    var tags = dot.allTags || dot.tags || [];
    var personal = false;
    for (var i = 0; i < tags.length; i++) {
      var kind = humandot.classifyTag(tags[i]);
      if (kind === TAG.PUBLIC) return 'public';
      if (kind === TAG.PERSONAL) personal = true;
    }
    return personal ? 'personal' : 'plain';
  }

  function dotSignature(dot) {
    return [dot.line, dot.longitude, dot.latitude, markerKind(dot), humandot.label(dot)].join('');
  }

  function DotMap(element, options) {
    options = options || {};

    this.onSelect = null;     // function(dotIndex)
    this.onMove = null;       // function(dotIndex, longitude, latitude)
    this.onAdd = null;        // function(longitude, latitude)
    this.onPointer = null;    // function({longitude, latitude} | null)
    this.onView = null;       // function({longitude, latitude, zoom})

    this.markers = [];
    this.dots = [];
    this.selected = -1;
    this.armed = false;
    this._signature = null;

    this.map = L.map(element, { zoomControl: true, worldCopyJump: true })
      .setView(options.center || DEFAULT_CENTER, options.zoom || DEFAULT_ZOOM);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(this.map);

    this.layer = L.layerGroup().addTo(this.map);

    this._bind();
    this._addControls();
  }

  DotMap.prototype._bind = function () {
    var self = this;

    this.map.on('click', function (event) {
      if (!self.armed) return;
      self.setArmed(false);
      if (self.onAdd) self.onAdd(event.latlng.lng, event.latlng.lat);
    });

    this.map.on('mousemove', function (event) {
      if (self.onPointer) self.onPointer({ longitude: event.latlng.lng, latitude: event.latlng.lat });
    });

    this.map.on('mouseout', function () {
      if (self.onPointer) self.onPointer(null);
    });

    this.map.on('moveend zoomend', function () {
      self._emitView();
    });
  };

  // a small button that arms "next click adds a dot"
  DotMap.prototype._addControls = function () {
    var self = this;
    var Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var container = L.DomUtil.create('div', 'leaflet-bar map-control');
        var button = L.DomUtil.create('a', 'map-control__button', container);
        button.href = '#';
        button.title = 'Add a dot (click the map)';
        button.innerHTML = '+';
        L.DomEvent.on(button, 'click', function (event) {
          L.DomEvent.stop(event);
          self.setArmed(!self.armed);
        });
        self._addButton = button;
        return container;
      }
    });
    this.map.addControl(new Control());
  };

  DotMap.prototype.setArmed = function (armed) {
    this.armed = !!armed;
    var container = this.map.getContainer();
    container.classList.toggle('map--armed', this.armed);
    if (this._addButton) this._addButton.classList.toggle('is-active', this.armed);
  };

  DotMap.prototype._emitView = function () {
    if (!this.onView) return;
    var center = this.map.getCenter();
    this.onView({ longitude: center.lng, latitude: center.lat, zoom: this.map.getZoom() });
  };

  /* --------------------------------------------------------------- markers */

  DotMap.prototype.setDots = function (dots) {
    var signature = dots.map(dotSignature).join('');
    if (signature === this._signature) {
      this.dots = dots;
      return;
    }
    this._signature = signature;
    this.dots = dots;
    this.layer.clearLayers();
    this.markers = [];

    var self = this;
    dots.forEach(function (dot, index) {
      if (!dot.valid) {
        self.markers.push(null);
        return;
      }
      var marker = L.marker([dot.latitude, dot.longitude], {
        draggable: true,
        keyboard: false,
        icon: L.divIcon({
          className: 'dot-marker dot-marker--' + markerKind(dot),
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        })
      });

      var label = humandot.label(dot);
      if (label) marker.bindTooltip(label, { direction: 'top', offset: [0, -8] });

      marker.on('click', function () {
        if (self.onSelect) self.onSelect(index);
      });

      marker.on('dragend', function () {
        var position = marker.getLatLng();
        if (self.onMove) self.onMove(index, position.lng, position.lat);
      });

      self.markers.push(marker);
      self.layer.addLayer(marker);
    });

    this._paintSelection();
  };

  DotMap.prototype.setSelected = function (index) {
    if (index === this.selected) return;
    this.selected = index;
    this._paintSelection();
  };

  DotMap.prototype._paintSelection = function () {
    var self = this;
    this.markers.forEach(function (marker, index) {
      if (!marker || !marker._icon) return;
      marker._icon.classList.toggle('dot-marker--selected', index === self.selected);
    });
  };

  /* ------------------------------------------------------------------ view */

  DotMap.prototype.panToDot = function (index, zoom) {
    var dot = this.dots[index];
    if (!dot || !dot.valid) return;
    if (zoom) {
      this.map.setView([dot.latitude, dot.longitude], Math.max(this.map.getZoom(), zoom));
    } else {
      this.map.panTo([dot.latitude, dot.longitude]);
    }
  };

  DotMap.prototype.revealDot = function (index) {
    var dot = this.dots[index];
    if (!dot || !dot.valid) return;
    if (!this.map.getBounds().pad(-0.1).contains([dot.latitude, dot.longitude])) {
      this.map.panTo([dot.latitude, dot.longitude]);
    }
  };

  DotMap.prototype.fitToDots = function () {
    var points = this.dots
      .filter(function (dot) { return dot.valid; })
      .map(function (dot) { return [dot.latitude, dot.longitude]; });
    if (points.length === 0) return false;
    if (points.length === 1) {
      this.map.setView(points[0], Math.max(this.map.getZoom(), 14));
    } else {
      this.map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    }
    return true;
  };

  DotMap.prototype.center = function () {
    var center = this.map.getCenter();
    return { longitude: center.lng, latitude: center.lat, zoom: this.map.getZoom() };
  };

  DotMap.prototype.setView = function (view) {
    this.map.setView([view.latitude, view.longitude], view.zoom);
  };

  DotMap.prototype.invalidateSize = function () {
    this.map.invalidateSize();
  };

  global.DOTE.DotMap = DotMap;
})(this);
