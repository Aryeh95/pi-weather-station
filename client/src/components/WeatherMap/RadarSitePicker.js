// RadarScope-style radar site picker: a labelled chip on every WSR-88D,
// tap to pin the single-site layer to that radar, tap the pinned one to
// go back to automatic. The active site (whatever the frames poller is
// serving, pinned or not) is highlighted; a pinned one also carries a
// pin mark so "auto happened to pick this" and "I chose this" read
// differently.
//
// Chips are Leaflet divIcon markers: 159 of them is nothing, and using
// real markers (rather than a canvas) keeps them tappable on the kiosk
// touch screen. `bubblingMouseEvents: false` so the tap never reaches
// the map click handler that moves the location pin.

import React, { useMemo } from "react";
import PropTypes from "prop-types";
import L from "leaflet";
import { Marker } from "react-leaflet";

import { NEXRAD_SITES, iemSiteId } from "./radarSites";
import styles from "./styles.css";

/**
 * @param {Object} props
 * @param {String|null} props.activeSite 3-letter id the site layer is currently serving
 * @param {String} props.pinnedSite 3-letter manual override, "" for automatic
 * @param {Boolean} props.interactive false renders the chips but ignores taps (remote clients)
 * @param {Function} props.onPick called with a 3-letter id, or "" to return to automatic
 * @returns {JSX.Element}
 */
const RadarSitePicker = ({ activeSite = null, pinnedSite = "", interactive = true, onPick }) => {
  // One icon per (state) rather than per site: Leaflet clones the html
  // per marker anyway, and the three variants are all that differ.
  const icons = useMemo(() => {
    const mk = (id, cls) => L.divIcon({
      className: styles.radarSiteIcon,
      html: `<span class="${styles.radarSiteChip} ${cls}">${id}</span>`,
      iconSize: null,
      iconAnchor: [0, 0],
    });
    return {
      plain: (id) => mk(id, ""),
      active: (id) => mk(id, styles.radarSiteChipActive),
      pinned: (id) => mk(id, `${styles.radarSiteChipActive} ${styles.radarSiteChipPinned}`),
    };
  }, []);

  return (
    <>
      {NEXRAD_SITES.map((s) => {
        const id3 = iemSiteId(s.id);
        const isPinned = pinnedSite && pinnedSite === id3;
        const isActive = activeSite && activeSite === id3;
        const icon = isPinned ? icons.pinned(s.id) : (isActive ? icons.active(s.id) : icons.plain(s.id));
        return (
          <Marker
            key={s.id}
            position={[s.lat, s.lon]}
            icon={icon}
            title={`${s.id} ${s.name}`}
            interactive={interactive}
            bubblingMouseEvents={false}
            keyboard={false}
            eventHandlers={interactive ? {
              click: () => onPick(isPinned ? "" : id3),
            } : undefined}
          />
        );
      })}
    </>
  );
};

RadarSitePicker.propTypes = {
  activeSite: PropTypes.string,
  pinnedSite: PropTypes.string,
  interactive: PropTypes.bool,
  onPick: PropTypes.func.isRequired,
};

export default RadarSitePicker;
