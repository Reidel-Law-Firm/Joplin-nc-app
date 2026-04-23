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
