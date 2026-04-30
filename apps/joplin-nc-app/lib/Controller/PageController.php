<?php
declare(strict_types=1);

namespace OCA\Joplin\Controller;

use OCA\Joplin\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {

    public function __construct(
        string $appName,
        IRequest $request,
        private IInitialState $initialState,
        private ?string $userId,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function index(): TemplateResponse {
        // Vendored libraries (marked + DOMPurify) for Markdown rendering
        // in the read-only viewer. Loaded BEFORE joplin-main so they're
        // available as window.marked / window.DOMPurify when the SPA boots.
        Util::addScript(Application::APP_ID, 'vendor/marked.min');
        Util::addScript(Application::APP_ID, 'vendor/purify.min');
        // Toast UI Editor — vendored WYSIWYG/Markdown rich-text editor.
        // Markdown is the source of truth (editor.getMarkdown()), so the
        // existing Joplin save/sync pipeline is byte-compatible.
        Util::addScript(Application::APP_ID, 'vendor/toastui-editor-all.min');
        Util::addStyle(Application::APP_ID, 'toastui-editor.min');
        Util::addScript(Application::APP_ID, 'joplin-main');
        Util::addStyle(Application::APP_ID, 'joplin');

        $this->initialState->provideInitialState('user', $this->userId ?? '');

        $response = new TemplateResponse(Application::APP_ID, 'main');

        // Allow inline SVG data URIs and same-origin resources only.
        $csp = new ContentSecurityPolicy();
        $csp->addAllowedImageDomain('data:');
        $response->setContentSecurityPolicy($csp);

        return $response;
    }
}
