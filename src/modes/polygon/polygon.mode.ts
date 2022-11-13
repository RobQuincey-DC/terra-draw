import {
    TerraDrawMouseEvent,
    TerraDrawAdapterStyling,
    TerraDrawKeyboardEvent,
    HexColor,
} from "../../common";
import { Feature, Point, Polygon } from "geojson";
import { selfIntersects } from "../../geometry/boolean/self-intersects";
import { TerraDrawBaseDrawMode } from "../base.mode";
import { PixelDistanceBehavior } from "../pixel-distance.behavior";
import { ClickBoundingBoxBehavior } from "../click-bounding-box.behavior";
import { BehaviorConfig } from "../base.behavior";
import { createPolygon } from "../../util/geoms";
import { SnappingBehavior } from "../snapping.behavior";
import { coordinatesIdentical } from "../../geometry/coordinates-identical";
import { ClosingPointsBehavior } from "./behaviors/closing-points.behavior";
import { getDefaultStyling } from "../../util/styling";
import { GeoJSONStoreFeatures } from "../../store/store";

type TerraDrawPolygonModeKeyEvents = {
    cancel: KeyboardEvent["key"];
};

type PolygonStyling = {
    fillColor: HexColor,
    outlineColor: HexColor,
    outlineWidth: number,
    fillOpacity: number,
    closingPointWidth: number,
    closingPointColor: HexColor,
    closingPointOutlineWidth: number,
    closingPointOutlineColor: HexColor
}

export class TerraDrawPolygonMode extends TerraDrawBaseDrawMode<PolygonStyling> {
    mode = "polygon";

    private currentCoordinate = 0;
    private currentId: string | undefined;
    private allowSelfIntersections: boolean;
    private keyEvents: TerraDrawPolygonModeKeyEvents;
    private snappingEnabled: boolean;
    private isClosed = false;

    // Behaviors
    private snapping!: SnappingBehavior;
    private pixelDistance!: PixelDistanceBehavior;
    private closingPoints!: ClosingPointsBehavior;

    constructor(options?: {
        allowSelfIntersections?: boolean;
        snapping?: boolean;
        pointerDistance?: number;
        styles?: Partial<PolygonStyling>;
        keyEvents?: TerraDrawPolygonModeKeyEvents;
    }) {
        super(options);

        this.snappingEnabled =
            options && options.snapping !== undefined ? options.snapping : false;

        this.allowSelfIntersections =
            options && options.allowSelfIntersections !== undefined
                ? options.allowSelfIntersections
                : true;

        this.keyEvents =
            options && options.keyEvents ? options.keyEvents : { cancel: "Escape" };
    }

    public registerBehaviors(config: BehaviorConfig) {
        this.pixelDistance = new PixelDistanceBehavior(config);
        this.snapping = new SnappingBehavior(
            config,
            this.pixelDistance,
            new ClickBoundingBoxBehavior(config)
        );
        this.closingPoints = new ClosingPointsBehavior(config, this.pixelDistance);
    }

    start() {
        this.setStarted();
        this.setCursor("crosshair");
    }
    stop() {
        this.setStopped();
        this.setCursor("unset");
        this.cleanUp();
    }

    onMouseMove(event: TerraDrawMouseEvent) {
        this.setCursor("crosshair");

        if (!this.currentId || this.currentCoordinate === 0) {
            return;
        }

        const closestCoord = this.snappingEnabled
            ? this.snapping.getSnappableCoordinate(event, this.currentId)
            : undefined;

        const currentPolygonCoordinates = this.store.getGeometryCopy<Polygon>(
            this.currentId
        ).coordinates[0];

        if (closestCoord) {
            event.lng = closestCoord[0];
            event.lat = closestCoord[1];
        }

        let updatedCoordinates;

        if (this.currentCoordinate === 1) {
            // We must add a very small epsilon value so that Mapbox GL
            // renders the polygon - There might be a cleaner solution?
            const epsilon = 1 / Math.pow(10, this.coordinatePrecision - 1);
            const offset = Math.max(0.000001, epsilon);

            updatedCoordinates = [
                currentPolygonCoordinates[0],
                [event.lng, event.lat],
                [event.lng, event.lat + offset],
                currentPolygonCoordinates[0],
            ];
        } else if (this.currentCoordinate === 2) {

            updatedCoordinates = [
                currentPolygonCoordinates[0],
                currentPolygonCoordinates[1],
                [event.lng, event.lat],
                currentPolygonCoordinates[0],
            ];
        } else {

            const { isClosing, isPreviousClosing } = this.closingPoints.isClosingPoint(event);

            if (isPreviousClosing || isClosing) {
                this.setCursor('pointer');
                updatedCoordinates = [
                    ...currentPolygonCoordinates.slice(0, -2),
                    currentPolygonCoordinates[0],
                    currentPolygonCoordinates[0]
                ];

                if (!this.isClosed) {
                    this.isClosed = true;
                }
            } else {

                if (this.isClosed) {
                    this.isClosed = false;
                }

                updatedCoordinates = [
                    ...currentPolygonCoordinates.slice(0, -2),
                    [event.lng, event.lat],
                    currentPolygonCoordinates[0],
                ];
            }
        }

        this.store.updateGeometry([
            {
                id: this.currentId,
                geometry: {
                    type: "Polygon",
                    coordinates: [updatedCoordinates],
                },
            },
        ]);

        if (this.closingPoints.ids.length) {
            this.closingPoints.update(updatedCoordinates);
        }
    }

    onClick(event: TerraDrawMouseEvent) {
        const closestCoord =
            this.currentId && this.snappingEnabled
                ? this.snapping.getSnappableCoordinate(event, this.currentId)
                : undefined;

        if (this.currentCoordinate === 0) {
            if (closestCoord) {
                event.lng = closestCoord[0];
                event.lat = closestCoord[1];
            }

            const [newId] = this.store.create([
                {
                    geometry: {
                        type: "Polygon",
                        coordinates: [
                            [
                                [event.lng, event.lat],
                                [event.lng, event.lat],
                                [event.lng, event.lat],
                                [event.lng, event.lat],
                            ],
                        ],
                    },
                    properties: { mode: this.mode },
                },
            ]);
            this.currentId = newId;
            this.currentCoordinate++;
        } else if (this.currentCoordinate === 1 && this.currentId) {
            if (closestCoord) {
                event.lng = closestCoord[0];
                event.lat = closestCoord[1];
            }

            const currentPolygonGeometry = this.store.getGeometryCopy<Polygon>(
                this.currentId
            );

            const previousCoordinate = currentPolygonGeometry.coordinates[0][0];
            const isIdentical = coordinatesIdentical([event.lng, event.lat], previousCoordinate);

            if (isIdentical) {
                return;
            }

            this.store.updateGeometry([
                {
                    id: this.currentId,
                    geometry: {
                        type: "Polygon",
                        coordinates: [
                            [
                                currentPolygonGeometry.coordinates[0][0],
                                [event.lng, event.lat],
                                [event.lng, event.lat],
                                currentPolygonGeometry.coordinates[0][0],
                            ],
                        ],
                    },
                },
            ]);

            this.currentCoordinate++;
        } else if (this.currentCoordinate === 2 && this.currentId) {
            if (closestCoord) {
                event.lng = closestCoord[0];
                event.lat = closestCoord[1];
            }

            const currentPolygonCoordinates = this.store.getGeometryCopy<Polygon>(
                this.currentId
            ).coordinates[0];

            const previousCoordinate = currentPolygonCoordinates[1];
            const isIdentical = coordinatesIdentical([event.lng, event.lat], previousCoordinate);

            if (isIdentical) {
                return;
            }

            if (this.currentCoordinate === 2) {
                this.closingPoints.create(currentPolygonCoordinates, 'polygon');
            }

            this.store.updateGeometry([
                {
                    id: this.currentId,
                    geometry: {
                        type: "Polygon",
                        coordinates: [
                            [
                                currentPolygonCoordinates[0],
                                currentPolygonCoordinates[1],
                                [event.lng, event.lat],
                                [event.lng, event.lat],
                                currentPolygonCoordinates[0],
                            ],
                        ],
                    },
                },
            ]);

            this.currentCoordinate++;
        } else if (this.currentId) {


            const currentPolygonCoordinates = this.store.getGeometryCopy<Polygon>(
                this.currentId
            ).coordinates[0];

            const { isClosing, isPreviousClosing } = this.closingPoints.isClosingPoint(event);

            if (isPreviousClosing || isClosing) {

                this.store.updateGeometry([
                    {
                        id: this.currentId,
                        geometry: {
                            type: "Polygon",
                            coordinates: [
                                [
                                    ...currentPolygonCoordinates.slice(0, -2),
                                    currentPolygonCoordinates[0],
                                ],
                            ],
                        },
                    },
                ]);

                this.currentCoordinate = 0;
                this.currentId = undefined;
                this.closingPoints.delete();
            } else {
                if (closestCoord) {
                    event.lng = closestCoord[0];
                    event.lat = closestCoord[1];
                }

                const previousCoordinate = currentPolygonCoordinates[this.currentCoordinate - 1];
                const isIdentical = coordinatesIdentical([event.lng, event.lat], previousCoordinate);

                if (isIdentical) {
                    return;
                }

                const updatedPolygon = createPolygon([
                    [
                        ...currentPolygonCoordinates.slice(0, -1),
                        [event.lng, event.lat], // New point that onMouseMove can manipulate
                        currentPolygonCoordinates[0],
                    ],
                ]);

                if (this.currentCoordinate > 2 && !this.allowSelfIntersections) {
                    const hasSelfIntersections = selfIntersects(updatedPolygon);

                    if (hasSelfIntersections) {
                        // Don't update the geometry!
                        return;
                    }
                }

                // If not close to the final point, keep adding points
                this.store.updateGeometry([
                    { id: this.currentId, geometry: updatedPolygon.geometry },
                ]);
                this.currentCoordinate++;
            }
        }
    }

    onKeyUp(event: TerraDrawKeyboardEvent) {
        if (event.key === this.keyEvents.cancel) {
            this.cleanUp();
        }
    }

    onKeyDown() { }

    onDragStart() {
        // We want to allow the default drag
        // cursor to exist
        this.setCursor("unset");
    }
    onDrag() { }
    onDragEnd() {
        // Set it back to crosshair
        this.setCursor("crosshair");
    }

    cleanUp() {
        try {
            if (this.currentId) {
                this.store.delete([this.currentId]);
            }
            if (this.closingPoints.ids.length) {
                this.closingPoints.delete();
            }
        } catch (error) { }
        this.currentId = undefined;
        this.currentCoordinate = 0;
    }

    styleFeature(
        feature: GeoJSONStoreFeatures
    ): TerraDrawAdapterStyling {

        const styles = { ...getDefaultStyling() };

        if (feature.properties.mode === this.mode) {
            if (feature.geometry.type === 'Polygon') {
                styles.polygonFillColor = this.styles.fillColor || styles.polygonFillColor;
                styles.polygonOutlineColor = this.styles.outlineColor || styles.polygonOutlineColor;
                styles.polygonOutlineWidth = this.styles.outlineWidth || styles.polygonOutlineWidth;
                styles.polygonFillColor = this.styles.fillColor || styles.polygonFillColor;
                styles.zIndex = 10;
                return styles;
            }

            else if (feature.geometry.type === 'Point') {
                styles.pointWidth = this.styles.closingPointWidth || styles.pointWidth;
                styles.pointColor = this.styles.closingPointColor || styles.pointColor;
                styles.pointOutlineColor = this.styles.closingPointOutlineColor || "#ffffff";
                styles.pointOutlineWidth = this.styles.closingPointOutlineWidth || 2;
                styles.zIndex = 30;
                return styles;
            }
        }

        return styles;
    }
}