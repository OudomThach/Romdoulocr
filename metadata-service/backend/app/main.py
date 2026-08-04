import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import cors_list, settings
from .errors import APIError, api_error_handler, http_exception_handler, validation_error_handler
from .routers import auth, export, health, records, stats
from .security import seed_admin


@asynccontextmanager
async def lifespan(app: FastAPI):
    await seed_admin()
    yield


app = FastAPI(title=settings.app_name, version=settings.version, docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)

origins = cors_list()
if origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.add_exception_handler(APIError, api_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)
app.add_exception_handler(StarletteHTTPException, http_exception_handler)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(records.router)
app.include_router(export.router)
app.include_router(stats.router)


@app.middleware("http")
async def api_meta_alias(request, call_next):
    # The portal is served under /portal on the shared Romdoul host, where the
    # metadata API lives behind /api-meta (romdoul nginx). The same /api-meta
    # prefix must also work when the service is hit directly (:8095), so the
    # portal can use one base URL everywhere. Strip the prefix internally.
    if request.url.path.startswith("/api-meta/"):
        request.scope["path"] = request.url.path[len("/api-meta") :]
        request.scope["raw_path"] = request.scope["path"].encode()
    return await call_next(request)

INDEX = os.path.join(settings.static_dir, "index.html")


@app.get("/", include_in_schema=False, response_model=None)
async def index() -> FileResponse | HTMLResponse:
    if os.path.exists(INDEX):
        return FileResponse(INDEX)
    return HTMLResponse("<h3>metadata-service API</h3><p>Docs: <a href='/api/docs'>/api/docs</a></p>")


if os.path.isdir(settings.static_dir):
    # Portal assets (built with base /portal/ so they don't collide with the
    # Romdoul SPA's own /assets on the shared nginx host).
    app.mount("/portal", StaticFiles(directory=settings.static_dir, html=True), name="portal")
    app.mount("/assets", StaticFiles(directory=os.path.join(settings.static_dir, "assets")), name="assets")
